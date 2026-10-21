package store

import (
	"context"
	"database/sql"
	"encoding/json"
	"fmt"
// @@ since full-payload
	"time"
// @@ end

// @@ since move-domain
	"training.example/orders/internal/domain"
// @@ end
// @@ until move-domain
	"training.example/orders/src"
// @@ end
)

// OrdersTopic is the Kafka topic the relay publishes order messages to
// (contracts/asyncapi/order-events.yaml).
const OrdersTopic = "orders.events"

// PurgedStatus is the status a message carries when the retention job removed the order.
const PurgedStatus = "purged"

// @@ since full-payload
// OrderChanged is the message announcing that an order changed. Its JSON form
// is the OrderChanged payload of contracts/asyncapi/order-events.yaml.
type OrderChanged struct {
	OrderID    string        `json:"orderId"`
	CustomerID string        `json:"customerId,omitempty"`
	Status     string        `json:"status"`
	TotalCents int64         `json:"totalCents"`
	Items      []ChangedItem `json:"items,omitempty"`
	OccurredAt time.Time     `json:"occurredAt"`
}

// ChangedItem is one order line in an OrderChanged message.
type ChangedItem struct {
	SKU        string `json:"sku"`
	Quantity   int    `json:"quantity"`
	PriceCents int64  `json:"priceCents"`
}

// @@ end
// @@ since outbox-write until full-payload
// OrderChanged is the message announcing that an order changed. Its JSON form
// is the OrderChanged payload of contracts/asyncapi/order-events.yaml.
type OrderChanged struct {
	OrderID string `json:"orderId"`
	Status  string `json:"status"`
}

// @@ end
// @@ since outbox-write
// OutboxWriter inserts messages into the outbox table. It only works inside a
// transaction the caller owns, so a message exists exactly when the change it
// announces was committed (docs/adr/0002-outbox.md).
type OutboxWriter struct {
	topic string
}

// NewOutboxWriter returns a writer that targets topic.
func NewOutboxWriter(topic string) *OutboxWriter {
	return &OutboxWriter{topic: topic}
}

// Write queues one message in the caller's transaction.
func (w *OutboxWriter) Write(ctx context.Context, tx *sql.Tx, change OrderChanged) error {
	payload, err := json.Marshal(change)
	if err != nil {
		return fmt.Errorf("encode message for order %s: %w", change.OrderID, err)
	}
	if _, err := tx.ExecContext(ctx,
		`INSERT INTO outbox (aggregate_id, topic, payload) VALUES ($1, $2, $3)`,
		change.OrderID, w.topic, payload); err != nil {
		return fmt.Errorf("queue message for order %s: %w", change.OrderID, err)
	}
	return nil
}

// changeOf describes the order's current state as a message.
// @@ end
// @@ since outbox-write until full-payload
func changeOf(order domain.Order) OrderChanged {
	return OrderChanged{OrderID: order.ID, Status: string(order.Status)}
}
// @@ end
// @@ since full-payload
func changeOf(order domain.Order) OrderChanged {
	change := OrderChanged{
		OrderID:    order.ID,
		CustomerID: order.CustomerID,
		Status:     string(order.Status),
		TotalCents: order.Total,
		OccurredAt: order.UpdatedAt,
	}
	for _, item := range order.Items {
		change.Items = append(change.Items, ChangedItem{SKU: item.SKU, Quantity: item.Quantity, PriceCents: item.PriceCents})
	}
	return change
}
// @@ end
