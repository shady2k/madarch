package main

import (
	"context"
	"log/slog"
	"time"

	"training.example/orders/internal/application"
)

// retentionInterval is how often the retention job looks for expired orders.
const retentionInterval = 6 * time.Hour

// runRetention removes orders that expired every retentionInterval until
// ctx is cancelled.
func runRetention(ctx context.Context, orders *application.Service, log *slog.Logger) error {
	ticker := time.NewTicker(retentionInterval)
	defer ticker.Stop()
	for {
		select {
		case <-ctx.Done():
			return nil
		case <-ticker.C:
			removed, err := orders.RunRetentionJob(ctx)
			if err != nil {
				log.Error("retention job failed", "removed", removed, "error", err)
				continue
			}
			log.Info("retention job finished", "removed", removed)
		}
	}
}
