// Package relay publishes the rows of the outbox table to the broker.
package relay

import (
	"context"
	"database/sql"
	"fmt"
	"log/slog"
	"time"

	"github.com/lib/pq"
)

// Publisher sends one message to the broker. KafkaPublisher implements it.
type Publisher interface {
	Publish(ctx context.Context, topic, key string, payload []byte) error
}

// Relay moves messages from the outbox table to the broker: the second half of
// the transactional outbox (docs/adr/0002-outbox.md). A message is marked
// published only after the broker accepted it, so a crash can repeat a
// message but never lose one; consumers must tolerate duplicates.
type Relay struct {
	db        *sql.DB
	publisher Publisher
	log       *slog.Logger
	interval  time.Duration
}

// New returns a relay that looks for unpublished messages every interval.
func New(db *sql.DB, publisher Publisher, log *slog.Logger, interval time.Duration) *Relay {
	return &Relay{db: db, publisher: publisher, log: log, interval: interval}
}

// batchSize is how many messages one pass takes.
const batchSize = 100

// Run publishes until ctx is cancelled.
func (r *Relay) Run(ctx context.Context) error {
	ticker := time.NewTicker(r.interval)
	defer ticker.Stop()
	for {
		select {
		case <-ctx.Done():
			return nil
		case <-ticker.C:
			n, err := r.Flush(ctx)
			if err != nil {
				r.log.Error("outbox flush failed", "error", err)
				continue
			}
			if n > 0 {
				r.log.Info("outbox flushed", "messages", n)
			}
		}
	}
}

type pending struct {
	id      int64
	key     string
	topic   string
	payload []byte
}

// @@ since relay until claim-rows
// Flush publishes one batch of unpublished messages, oldest first, and returns how many.
func (r *Relay) Flush(ctx context.Context) (int, error) {
	rows, err := r.db.QueryContext(ctx,
		`SELECT id, aggregate_id, topic, payload FROM outbox WHERE published_at IS NULL ORDER BY id LIMIT $1`, batchSize)
	if err != nil {
		return 0, err
	}
	var batch []pending
	for rows.Next() {
		var p pending
		if err := rows.Scan(&p.id, &p.key, &p.topic, &p.payload); err != nil {
			_ = rows.Close()
			return 0, err
		}
		batch = append(batch, p)
	}
	if err := rows.Close(); err != nil {
		return 0, err
	}
	var published []int64
	for _, p := range batch {
		if err := r.publisher.Publish(ctx, p.topic, p.key, p.payload); err != nil {
			return len(published), fmt.Errorf("publish message %d: %w", p.id, err)
		}
		published = append(published, p.id)
	}
	return len(published), r.markPublished(ctx, r.db, published)
}

// @@ end
// @@ since claim-rows
// Flush publishes one batch of unpublished messages, oldest first, and returns
// how many. The rows are locked with SKIP LOCKED for the length of the
// transaction, so two relays never publish the same message.
func (r *Relay) Flush(ctx context.Context) (int, error) {
	tx, err := r.db.BeginTx(ctx, nil)
	if err != nil {
		return 0, err
	}
	defer func() { _ = tx.Rollback() }()
	rows, err := tx.QueryContext(ctx,
		`SELECT id, aggregate_id, topic, payload FROM outbox WHERE published_at IS NULL ORDER BY id LIMIT $1 FOR UPDATE SKIP LOCKED`, batchSize)
	if err != nil {
		return 0, err
	}
	var batch []pending
	for rows.Next() {
		var p pending
		if err := rows.Scan(&p.id, &p.key, &p.topic, &p.payload); err != nil {
			_ = rows.Close()
			return 0, err
		}
		batch = append(batch, p)
	}
	if err := rows.Close(); err != nil {
		return 0, err
	}
	var published []int64
	for _, p := range batch {
		if err := r.publisher.Publish(ctx, p.topic, p.key, p.payload); err != nil {
			return 0, fmt.Errorf("publish message %d: %w", p.id, err)
		}
		published = append(published, p.id)
	}
	if err := r.markPublished(ctx, tx, published); err != nil {
		return 0, err
	}
	return len(published), tx.Commit()
}

// @@ end
// execer is what *sql.DB and *sql.Tx share.
type execer interface {
	ExecContext(ctx context.Context, query string, args ...any) (sql.Result, error)
}

func (r *Relay) markPublished(ctx context.Context, db execer, ids []int64) error {
	if len(ids) == 0 {
		return nil
	}
	_, err := db.ExecContext(ctx, `UPDATE outbox SET published_at = now() WHERE id = ANY($1)`, pq.Array(ids))
	return err
}
