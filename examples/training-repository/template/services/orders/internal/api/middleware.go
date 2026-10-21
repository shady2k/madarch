package api

import (
	"context"
// @@ since request-id-log
	"crypto/rand"
	"encoding/hex"
// @@ end
	"encoding/json"
	"log/slog"
	"net/http"
	"strings"
	"time"

	"github.com/golang-jwt/jwt/v5"
// @@ since request-id-log

	"training.example/orders/internal/logging"
// @@ end
)

// Middleware wraps a handler with behaviour that applies to many routes.
type Middleware func(http.Handler) http.Handler

// Chain composes middleware; the first one is the outermost, so it sees the
// request first and the response last.
func Chain(middleware ...Middleware) Middleware {
	return func(next http.Handler) http.Handler {
		for i := len(middleware) - 1; i >= 0; i-- {
			next = middleware[i](next)
		}
		return next
	}
}

// statusRecorder remembers the status code a handler wrote.
type statusRecorder struct {
	http.ResponseWriter
	status int
}

func (s *statusRecorder) WriteHeader(code int) {
	s.status = code
	s.ResponseWriter.WriteHeader(code)
}

// @@ since request-id-log
// requestIDHeader carries the id that ties one request to its log lines. A
// caller-supplied id is kept, so checkout and orders log the same one.
const requestIDHeader = "X-Request-Id"

// @@ end
// RequestLogger writes one log line per request with its method, path, status
// and duration.
func RequestLogger(log *slog.Logger) Middleware {
	return func(next http.Handler) http.Handler {
		return http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
			started := time.Now()
			recorder := &statusRecorder{ResponseWriter: w, status: http.StatusOK}
// @@ since request-id-log
			id := r.Header.Get(requestIDHeader)
			if id == "" {
				id = newRequestID()
			}
			w.Header().Set(requestIDHeader, id)
			requestLog := log.With("request_id", id)
			r = r.WithContext(logging.WithLogger(r.Context(), requestLog))
			next.ServeHTTP(recorder, r)
			requestLog.Info("request", "method", r.Method, "path", r.URL.Path, "status", recorder.status, "ms", time.Since(started).Milliseconds())
// @@ end
// @@ until request-id-log
			next.ServeHTTP(recorder, r)
			log.Info("request", "method", r.Method, "path", r.URL.Path, "status", recorder.status, "ms", time.Since(started).Milliseconds())
// @@ end
		})
	}
}

// @@ since request-id-log
func newRequestID() string {
	b := make([]byte, 8)
	if _, err := rand.Read(b); err != nil {
		return "unknown"
	}
	return hex.EncodeToString(b)
}

// @@ end
// @@ since errors
// RecoverPanics turns a panic in a handler into a 500 response and a log line,
// so one bad request cannot take the process down.
func RecoverPanics(log *slog.Logger) Middleware {
	return func(next http.Handler) http.Handler {
		return http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
			defer func() {
				if recovered := recover(); recovered != nil {
					log.Error("panic in handler", "path", r.URL.Path, "panic", recovered)
					writeJSON(w, http.StatusInternalServerError, errorBody{Error: "internal", Message: "internal error"})
				}
			}()
			next.ServeHTTP(w, r)
		})
	}
}

// @@ end
// Claims are what the orders service reads from a verified token.
type Claims struct {
	// CustomerID is the token's subject.
	CustomerID string
	// Role is "customer" or "support".
	Role string
}

type claimsKey struct{}

// ClaimsFromContext returns the claims RequireAuth stored for this request.
func ClaimsFromContext(ctx context.Context) (Claims, bool) {
	claims, ok := ctx.Value(claimsKey{}).(Claims)
	return claims, ok
}

// RequireAuth rejects requests without a valid HS256 bearer token signed with
// secret, and stores the claims in the request context.
func RequireAuth(secret string) Middleware {
	return func(next http.Handler) http.Handler {
		return http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
			header := r.Header.Get("Authorization")
			raw, found := strings.CutPrefix(header, "Bearer ")
			if !found {
				writeUnauthorized(w, "missing bearer token")
				return
			}
			token, err := jwt.Parse(raw, func(*jwt.Token) (any, error) { return []byte(secret), nil },
				jwt.WithValidMethods([]string{"HS256"}), jwt.WithExpirationRequired())
			if err != nil || !token.Valid {
				writeUnauthorized(w, "invalid token")
				return
			}
			mapClaims, _ := token.Claims.(jwt.MapClaims)
			subject, _ := mapClaims.GetSubject()
			role, _ := mapClaims["role"].(string)
			if role == "" {
				role = "customer"
			}
			ctx := context.WithValue(r.Context(), claimsKey{}, Claims{CustomerID: subject, Role: role})
			next.ServeHTTP(w, r.WithContext(ctx))
		})
	}
}

// RequireRole rejects callers whose role differs. It must run after RequireAuth.
func RequireRole(role string) Middleware {
	return func(next http.Handler) http.Handler {
		return http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
			claims, ok := ClaimsFromContext(r.Context())
			if !ok || claims.Role != role {
				w.Header().Set("Content-Type", "application/json")
				w.WriteHeader(http.StatusForbidden)
				_ = json.NewEncoder(w).Encode(map[string]string{"error": "forbidden"})
				return
			}
			next.ServeHTTP(w, r)
		})
	}
}

func writeUnauthorized(w http.ResponseWriter, reason string) {
	w.Header().Set("WWW-Authenticate", `Bearer realm="orders"`)
	w.Header().Set("Content-Type", "application/json")
	w.WriteHeader(http.StatusUnauthorized)
	_ = json.NewEncoder(w).Encode(map[string]string{"error": "unauthorized", "message": reason})
}
