// Package logging builds the service logger.
package logging

import (
	"log/slog"
	"os"
)

// New returns the JSON logger of the service.
func New(service string) *slog.Logger {
	return slog.New(slog.NewJSONHandler(os.Stdout, nil)).With("service", service)
}
