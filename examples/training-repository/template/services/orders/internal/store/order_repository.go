package store

import (
	"context"
	"database/sql"
// @@ since read-orders
	"errors"
// @@ end
// @@ since paging
	"fmt"
// @@ end
// @@ since expiry
	"time"
// @@ end

// @@ since read-orders
	"github.com/lib/pq"

// @@ end
// @@ since paging
	"training.example/orders/internal/application"
// @@ end
// @@ since move-domain
	"training.example/orders/internal/domain"
// @@ end
// @@ until move-domain
	"training.example/orders/src"
// @@ end
)

// OrderRepository implements application.OrderStore on database/sql.
type OrderRepository struct {
	// db is the connection pool.
	db *sql.DB
// @@ since outbox-write
	// outbox queues the messages the relay publishes.
	outbox *OutboxWriter
// @@ end
}

// NewOrderRepository returns a repository over db.
// @@ since place until outbox-write
func NewOrderRepository(db *sql.DB) *OrderRepository {
	return &OrderRepository{db: db}
}

// @@ end
// @@ since outbox-write
func NewOrderRepository(db *sql.DB, outbox *OutboxWriter) *OrderRepository {
	return &OrderRepository{db: db, outbox: outbox}
}

// @@ end
// inTx runs fn in a transaction: it commits when fn succeeds and rolls back otherwise.
func (r *OrderRepository) inTx(ctx context.Context, fn func(tx *sql.Tx) error) error {
	tx, err := r.db.BeginTx(ctx, nil)
	if err != nil {
		return err
	}
	if err := fn(tx); err != nil {
		_ = tx.Rollback()
		return err
	}
	return tx.Commit()
}

// @@ since place until cancel-ship
// Save inserts the order and its lines.
func (r *OrderRepository) Save(ctx context.Context, order domain.Order) error {
	return r.inTx(ctx, func(tx *sql.Tx) error {
		if err := insertOrder(ctx, tx, order); err != nil {
			return err
		}
		return insertItems(ctx, tx, order)
	})
}

// @@ end
// @@ since cancel-ship
// Create inserts the order and its lines.
func (r *OrderRepository) Create(ctx context.Context, order domain.Order) error {
	return r.inTx(ctx, func(tx *sql.Tx) error {
		if err := insertOrder(ctx, tx, order); err != nil {
			return err
		}
		if err := insertItems(ctx, tx, order); err != nil {
			return err
		}
// @@ since outbox-write
		return r.outbox.Write(ctx, tx, changeOf(order))
// @@ end
// @@ until outbox-write
		return nil
// @@ end
	})
}

// Save updates the status of an existing order.
func (r *OrderRepository) Save(ctx context.Context, order domain.Order) error {
	return r.inTx(ctx, func(tx *sql.Tx) error {
// @@ since cancel-ship until decline-reason
		result, err := tx.ExecContext(ctx, `UPDATE orders SET status = $2, updated_at = $3 WHERE id = $1`,
			order.ID, string(order.Status), order.UpdatedAt)
// @@ end
// @@ since decline-reason
		result, err := tx.ExecContext(ctx, `UPDATE orders SET status = $2, cancel_reason = NULLIF($3, ''), updated_at = $4 WHERE id = $1`,
			order.ID, string(order.Status), order.CancelReason, order.UpdatedAt)
// @@ end
		if err != nil {
			return err
		}
		if n, _ := result.RowsAffected(); n == 0 {
			return domain.ErrNotFound
		}
// @@ since outbox-write
		return r.outbox.Write(ctx, tx, changeOf(order))
// @@ end
// @@ until outbox-write
		return nil
// @@ end
	})
}

// @@ end
// @@ since place until preview
func insertOrder(ctx context.Context, tx *sql.Tx, o domain.Order) error {
	_, err := tx.ExecContext(ctx, `INSERT INTO orders (id, customer_id, status, total_cents, created_at, updated_at)
VALUES ($1, $2, $3, $4, $5, $6)`,
		o.ID, o.CustomerID, string(o.Status), o.Total, o.CreatedAt, o.UpdatedAt)
	return err
}

// @@ end
// @@ since preview until idempotent-place
func insertOrder(ctx context.Context, tx *sql.Tx, o domain.Order) error {
	_, err := tx.ExecContext(ctx, `INSERT INTO orders (id, customer_id, status, subtotal_cents, discount_cents, tax_cents, total_cents, created_at, updated_at)
VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9)`,
		o.ID, o.CustomerID, string(o.Status), o.Subtotal, o.Discount, o.Tax, o.Total, o.CreatedAt, o.UpdatedAt)
	return err
}

// @@ end
// @@ since idempotent-place
func insertOrder(ctx context.Context, tx *sql.Tx, o domain.Order) error {
	_, err := tx.ExecContext(ctx, `INSERT INTO orders (id, customer_id, status, subtotal_cents, discount_cents, tax_cents, total_cents, request_id, created_at, updated_at)
VALUES ($1, $2, $3, $4, $5, $6, $7, NULLIF($8, ''), $9, $10)`,
		o.ID, o.CustomerID, string(o.Status), o.Subtotal, o.Discount, o.Tax, o.Total, o.RequestID, o.CreatedAt, o.UpdatedAt)
	return err
}

// @@ end
// @@ since place until tax-rounding
func insertItems(ctx context.Context, tx *sql.Tx, o domain.Order) error {
	for _, item := range o.Items {
		if _, err := tx.ExecContext(ctx, `INSERT INTO order_items (order_id, sku, quantity, price_cents) VALUES ($1, $2, $3, $4)`,
			o.ID, item.SKU, item.Quantity, item.PriceCents); err != nil {
			return err
		}
	}
	return nil
}

// @@ end
// @@ since tax-rounding
func insertItems(ctx context.Context, tx *sql.Tx, o domain.Order) error {
	for _, item := range o.Items {
		if _, err := tx.ExecContext(ctx, `INSERT INTO order_items (order_id, sku, quantity, price_cents, zero_rated) VALUES ($1, $2, $3, $4, $5)`,
			o.ID, item.SKU, item.Quantity, item.PriceCents, item.ZeroRated); err != nil {
			return err
		}
	}
	return nil
}

// @@ end
// @@ since read-orders
// rowScanner is what *sql.Row and *sql.Rows have in common.
type rowScanner interface {
	Scan(dest ...any) error
}

// @@ end
// @@ since read-orders until preview
const orderColumns = `id, customer_id, status, total_cents, created_at, updated_at`

func scanOrder(row rowScanner) (domain.Order, error) {
	var o domain.Order
	var status string
	err := row.Scan(&o.ID, &o.CustomerID, &status, &o.Total, &o.CreatedAt, &o.UpdatedAt)
	o.Status = domain.Status(status)
	return o, err
}

// @@ end
// @@ since preview until idempotent-place
const orderColumns = `id, customer_id, status, subtotal_cents, discount_cents, tax_cents, total_cents, created_at, updated_at`

func scanOrder(row rowScanner) (domain.Order, error) {
	var o domain.Order
	var status string
	err := row.Scan(&o.ID, &o.CustomerID, &status, &o.Subtotal, &o.Discount, &o.Tax, &o.Total, &o.CreatedAt, &o.UpdatedAt)
	o.Status = domain.Status(status)
	return o, err
}

// @@ end
// @@ since idempotent-place until decline-reason
const orderColumns = `id, customer_id, status, subtotal_cents, discount_cents, tax_cents, total_cents, COALESCE(request_id, ''), created_at, updated_at`

func scanOrder(row rowScanner) (domain.Order, error) {
	var o domain.Order
	var status string
	err := row.Scan(&o.ID, &o.CustomerID, &status, &o.Subtotal, &o.Discount, &o.Tax, &o.Total, &o.RequestID, &o.CreatedAt, &o.UpdatedAt)
	o.Status = domain.Status(status)
	return o, err
}

// @@ end
// @@ since decline-reason
const orderColumns = `id, customer_id, status, subtotal_cents, discount_cents, tax_cents, total_cents, COALESCE(request_id, ''), COALESCE(cancel_reason, ''), created_at, updated_at`

func scanOrder(row rowScanner) (domain.Order, error) {
	var o domain.Order
	var status string
	err := row.Scan(&o.ID, &o.CustomerID, &status, &o.Subtotal, &o.Discount, &o.Tax, &o.Total, &o.RequestID, &o.CancelReason, &o.CreatedAt, &o.UpdatedAt)
	o.Status = domain.Status(status)
	return o, err
}

// @@ end
// @@ since read-orders
// Get returns the order with its lines, or domain.ErrNotFound.
func (r *OrderRepository) Get(ctx context.Context, id string) (domain.Order, error) {
	order, err := scanOrder(r.db.QueryRowContext(ctx, `SELECT `+orderColumns+` FROM orders WHERE id = $1`, id))
	if errors.Is(err, sql.ErrNoRows) {
		return domain.Order{}, domain.ErrNotFound
	}
	if err != nil {
		return domain.Order{}, err
	}
	orders := []domain.Order{order}
	if err := r.attachItems(ctx, orders); err != nil {
		return domain.Order{}, err
	}
	return orders[0], nil
}

// @@ end
// @@ since read-orders until paging
// List returns every order, newest first.
func (r *OrderRepository) List(ctx context.Context) ([]domain.Order, error) {
	rows, err := r.db.QueryContext(ctx, `SELECT `+orderColumns+` FROM orders ORDER BY created_at DESC, id DESC`)
	if err != nil {
		return nil, err
	}
	return r.collect(ctx, rows)
}

// @@ end
// @@ since paging
// List returns one page of orders, oldest first, after the order named by the
// cursor (AfterID). The cursor is the (created_at, id) position of that order.
func (r *OrderRepository) List(ctx context.Context, filter application.ListFilter) ([]domain.Order, error) {
	query := `SELECT ` + orderColumns + ` FROM orders WHERE true`
	var args []any
	if filter.AfterID != "" {
		args = append(args, filter.AfterID)
		query += fmt.Sprintf(` AND (created_at, id) > (SELECT created_at, id FROM orders WHERE id = $%d)`, len(args))
	}
// @@ since customer-filter
	if filter.CustomerID != "" {
		args = append(args, filter.CustomerID)
		query += fmt.Sprintf(` AND customer_id = $%d`, len(args))
	}
// @@ end
	args = append(args, filter.Limit)
	query += fmt.Sprintf(` ORDER BY created_at, id LIMIT $%d`, len(args))
	rows, err := r.db.QueryContext(ctx, query, args...)
	if err != nil {
		return nil, err
	}
	return r.collect(ctx, rows)
}

// @@ end
// @@ since read-orders
// collect reads the rows, closes them and attaches the lines.
func (r *OrderRepository) collect(ctx context.Context, rows *sql.Rows) ([]domain.Order, error) {
	defer rows.Close()
	var orders []domain.Order
	for rows.Next() {
		order, err := scanOrder(rows)
		if err != nil {
			return nil, err
		}
		orders = append(orders, order)
	}
	if err := rows.Err(); err != nil {
		return nil, err
	}
	if err := r.attachItems(ctx, orders); err != nil {
		return nil, err
	}
	return orders, nil
}

// @@ end
// @@ since read-orders until tax-rounding
// attachItems loads the lines of all the given orders in one query.
func (r *OrderRepository) attachItems(ctx context.Context, orders []domain.Order) error {
	if len(orders) == 0 {
		return nil
	}
	ids := make([]string, len(orders))
	index := make(map[string]int, len(orders))
	for i, o := range orders {
		ids[i] = o.ID
		index[o.ID] = i
	}
	rows, err := r.db.QueryContext(ctx, `SELECT order_id, sku, quantity, price_cents FROM order_items WHERE order_id = ANY($1) ORDER BY id`, pq.Array(ids))
	if err != nil {
		return err
	}
	defer rows.Close()
	for rows.Next() {
		var orderID string
		var item domain.Item
		if err := rows.Scan(&orderID, &item.SKU, &item.Quantity, &item.PriceCents); err != nil {
			return err
		}
		orders[index[orderID]].Items = append(orders[index[orderID]].Items, item)
	}
	return rows.Err()
}

// @@ end
// @@ since tax-rounding
// attachItems loads the lines of all the given orders in one query.
func (r *OrderRepository) attachItems(ctx context.Context, orders []domain.Order) error {
	if len(orders) == 0 {
		return nil
	}
	ids := make([]string, len(orders))
	index := make(map[string]int, len(orders))
	for i, o := range orders {
		ids[i] = o.ID
		index[o.ID] = i
	}
	rows, err := r.db.QueryContext(ctx, `SELECT order_id, sku, quantity, price_cents, zero_rated FROM order_items WHERE order_id = ANY($1) ORDER BY id`, pq.Array(ids))
	if err != nil {
		return err
	}
	defer rows.Close()
	for rows.Next() {
		var orderID string
		var item domain.Item
		if err := rows.Scan(&orderID, &item.SKU, &item.Quantity, &item.PriceCents, &item.ZeroRated); err != nil {
			return err
		}
		orders[index[orderID]].Items = append(orders[index[orderID]].Items, item)
	}
	return rows.Err()
}

// @@ end
// @@ since idempotent-place
// FindByRequestID returns the order the customer placed with the request id, or domain.ErrNotFound.
func (r *OrderRepository) FindByRequestID(ctx context.Context, customerID, requestID string) (domain.Order, error) {
	order, err := scanOrder(r.db.QueryRowContext(ctx,
		`SELECT `+orderColumns+` FROM orders WHERE customer_id = $1 AND request_id = $2`, customerID, requestID))
	if errors.Is(err, sql.ErrNoRows) {
		return domain.Order{}, domain.ErrNotFound
	}
	if err != nil {
		return domain.Order{}, err
	}
	orders := []domain.Order{order}
	if err := r.attachItems(ctx, orders); err != nil {
		return domain.Order{}, err
	}
	return orders[0], nil
}

// @@ end
// @@ since customers-check
// CustomerExists reports whether the customers table has the id.
func (r *OrderRepository) CustomerExists(ctx context.Context, id string) (bool, error) {
	var exists bool
	err := r.db.QueryRowContext(ctx, `SELECT EXISTS (SELECT 1 FROM customers WHERE id = $1)`, id).Scan(&exists)
	return exists, err
}

// @@ end
// @@ since expiry
// ListCreatedBefore returns up to limit orders created before cutoff that were
// not shipped. Which of them expired is the domain's decision (PurgeExpired).
func (r *OrderRepository) ListCreatedBefore(ctx context.Context, cutoff time.Time, limit int) ([]domain.Order, error) {
	rows, err := r.db.QueryContext(ctx,
		`SELECT `+orderColumns+` FROM orders WHERE created_at < $1 AND status <> 'shipped' ORDER BY created_at LIMIT $2`, cutoff, limit)
	if err != nil {
		return nil, err
	}
	defer rows.Close()
	var orders []domain.Order
	for rows.Next() {
		order, err := scanOrder(rows)
		if err != nil {
			return nil, err
		}
		orders = append(orders, order)
	}
	return orders, rows.Err()
}

// Delete removes the orders (their lines go with them) and queues one
// "purged" message per order, in the same transaction.
func (r *OrderRepository) Delete(ctx context.Context, ids []string) error {
	if len(ids) == 0 {
		return nil
	}
	return r.inTx(ctx, func(tx *sql.Tx) error {
		if _, err := tx.ExecContext(ctx, `DELETE FROM orders WHERE id = ANY($1)`, pq.Array(ids)); err != nil {
			return err
		}
		for _, id := range ids {
			change := OrderChanged{OrderID: id, Status: PurgedStatus}
// @@ since full-payload
			change.OccurredAt = time.Now().UTC()
// @@ end
			if err := r.outbox.Write(ctx, tx, change); err != nil {
				return err
			}
		}
		return nil
	})
}
// @@ end
