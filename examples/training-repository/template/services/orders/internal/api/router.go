// Package api is the HTTP layer of the orders service: routes, the middleware
// chain and the handlers. It calls the application layer and nothing below it.
package api

import (
// @@ since jwt
	"log/slog"
// @@ end
	"net/http"
)

// Deps are the collaborators the router needs; cmd/orders/main.go builds them
// and hands them in.
type Deps struct {
	// Orders serves the /orders routes.
	Orders *OrderHandlers
// @@ since jwt
	// Log is the service logger the request logger derives from.
	Log *slog.Logger
	// JWTSecret verifies the bearer tokens of the auth group.
	JWTSecret string
// @@ end
// @@ since metrics
	// Metrics counts requests and serves /metrics.
	Metrics *Metrics
// @@ end
}

// NewRouter registers every route and wraps the whole router in the global
// middleware chain.
func NewRouter(deps Deps) http.Handler {
	mux := http.NewServeMux()

// @@ since jwt
	// The auth group: a route registered through authed needs a valid token.
	authed := Chain(RequireAuth(deps.JWTSecret))
	support := Chain(RequireAuth(deps.JWTSecret), RequireRole("support"))

// @@ end
// @@ until jwt
	mux.HandleFunc("POST /orders", deps.Orders.Create)
// @@ end
// @@ since jwt
	mux.Handle("POST /orders", authed(http.HandlerFunc(deps.Orders.Create)))
// @@ end
// @@ since read-orders until jwt
	mux.HandleFunc("GET /orders", deps.Orders.List)
	mux.HandleFunc("GET /orders/{id}", deps.Orders.Get)
// @@ end
// @@ since jwt
	mux.Handle("GET /orders", authed(http.HandlerFunc(deps.Orders.List)))
	mux.Handle("GET /orders/{id}", authed(http.HandlerFunc(deps.Orders.Get)))
// @@ end
// @@ since cancel-ship until jwt
	mux.HandleFunc("POST /orders/{id}/cancel", deps.Orders.Cancel)
	mux.HandleFunc("POST /orders/{id}/ship", deps.Orders.Ship)
// @@ end
// @@ since jwt
	mux.Handle("POST /orders/{id}/cancel", authed(http.HandlerFunc(deps.Orders.Cancel)))
	mux.Handle("POST /orders/{id}/ship", support(http.HandlerFunc(deps.Orders.Ship)))
// @@ end
// @@ since export

	// The export is registered outside the auth group: the finance job that
	// pulls it runs inside the cluster and carries no token.
	mux.HandleFunc("GET /orders/export", deps.Orders.Export)
// @@ end

	mux.HandleFunc("GET /healthz", Health)
// @@ since metrics
	mux.Handle("GET /metrics", deps.Metrics)
// @@ end

// @@ until jwt
	return mux
// @@ end
// @@ since jwt until errors
	return Chain(RequestLogger(deps.Log))(mux)
// @@ end
// @@ since errors until metrics
	return Chain(RequestLogger(deps.Log), RecoverPanics(deps.Log))(mux)
// @@ end
// @@ since metrics
	return Chain(RequestLogger(deps.Log), RecoverPanics(deps.Log), deps.Metrics.Count)(mux)
// @@ end
}

// Health answers the liveness probe of Docker Compose and Kubernetes.
func Health(w http.ResponseWriter, _ *http.Request) {
	writeJSON(w, http.StatusOK, map[string]string{"status": "ok"})
}
