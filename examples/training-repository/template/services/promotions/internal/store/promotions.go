// Package store reads promotion codes from the promotions database.
package store

import (
	"context"
	"database/sql"
	"errors"
	"time"

	_ "github.com/lib/pq"
)

// ErrNotFound is returned when no active promotion has the code.
var ErrNotFound = errors.New("promotion not found")

// Promotion is a row of the promotions table.
type Promotion struct {
	ID       string
	Code     string
	Kind     string
	Value    int64
	MinCents int64
}

// Repository reads promotions.
type Repository struct {
	db *sql.DB
}

// Open connects to the promotions database.
func Open(ctx context.Context, url string) (*Repository, error) {
	db, err := sql.Open("postgres", url)
	if err != nil {
		return nil, err
	}
	if err := db.PingContext(ctx); err != nil {
		_ = db.Close()
		return nil, err
	}
	return &Repository{db: db}, nil
}

// Close closes the connection pool.
func (r *Repository) Close() error { return r.db.Close() }

// FindActive returns the unexpired, active promotion with the code, or ErrNotFound.
func (r *Repository) FindActive(ctx context.Context, code string, now time.Time) (Promotion, error) {
	var p Promotion
	err := r.db.QueryRowContext(ctx,
		`SELECT id, code, kind, value, COALESCE(min_cents, 0)
		   FROM promotions
		  WHERE code = $1 AND active AND (expires_at IS NULL OR expires_at > $2)`, code, now).
		Scan(&p.ID, &p.Code, &p.Kind, &p.Value, &p.MinCents)
	if errors.Is(err, sql.ErrNoRows) {
		return Promotion{}, ErrNotFound
	}
	return p, err
}
