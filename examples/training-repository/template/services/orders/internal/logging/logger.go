// Package logging builds the service logger and carries a request-scoped one
// in the context.
package logging

import (
// @@ since request-id-log
	"context"
// @@ end
	"log/slog"
	"os"
)

// New returns the JSON logger every component of the service starts from.
func New(service string) *slog.Logger {
	return slog.New(slog.NewJSONHandler(os.Stdout, nil)).With("service", service)
}
// @@ since request-id-log

type contextKey struct{}

// WithLogger returns a context that carries log.
func WithLogger(ctx context.Context, log *slog.Logger) context.Context {
	return context.WithValue(ctx, contextKey{}, log)
}

// FromContext returns the logger of the current request, or the default
// logger when the context does not carry one.
func FromContext(ctx context.Context) *slog.Logger {
	if log, ok := ctx.Value(contextKey{}).(*slog.Logger); ok {
		return log
	}
	return slog.Default()
}
// @@ end
