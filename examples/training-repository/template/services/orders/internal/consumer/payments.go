// Package consumer reads the events other services publish and turns them
// into order use cases.
package consumer

import (
	"context"
	"encoding/json"
	"errors"
	"log/slog"
	"strings"

	"github.com/segmentio/kafka-go"
)

// PaymentsTopic is the topic the payments service publishes to
// (contracts/asyncapi/order-events.yaml, channel payments.events).
const PaymentsTopic = "payments.events"

// PaymentEventHandler applies a payment event to an order.
// application.Service implements it.
type PaymentEventHandler interface {
// @@ since consume-events until decline-reason
	ApplyPaymentEvent(ctx context.Context, orderID, kind string) error
// @@ end
// @@ since decline-reason
	ApplyPaymentEvent(ctx context.Context, orderID, kind, note string) error
// @@ end
}

// paymentEvent is the JSON the payments service publishes.
type paymentEvent struct {
	Kind    string `json:"type"`
	OrderID string `json:"orderId"`
	Reason  string `json:"reason"`
}

// PaymentEvents consumes payments.events.
type PaymentEvents struct {
	reader  *kafka.Reader
	handler PaymentEventHandler
	log     *slog.Logger
}

// NewPaymentEvents returns a consumer in the group "orders", so the instances
// of the service share the topic.
func NewPaymentEvents(brokers string, handler PaymentEventHandler, log *slog.Logger) *PaymentEvents {
	reader := kafka.NewReader(kafka.ReaderConfig{
		Brokers: strings.Split(brokers, ","),
		GroupID: "orders",
		Topic:   PaymentsTopic,
	})
	return &PaymentEvents{reader: reader, handler: handler, log: log}
}

// Run applies events until ctx is cancelled. A message is committed after the
// handler returned, so a crash repeats it; applying a repeated event has to be
// harmless.
func (c *PaymentEvents) Run(ctx context.Context) error {
	defer c.reader.Close()
	for {
		message, err := c.reader.FetchMessage(ctx)
		if err != nil {
			if errors.Is(err, context.Canceled) {
				return nil
			}
			return err
		}
		c.handle(ctx, message)
		if err := c.reader.CommitMessages(ctx, message); err != nil {
			return err
		}
	}
}

func (c *PaymentEvents) handle(ctx context.Context, message kafka.Message) {
	var event paymentEvent
	if err := json.Unmarshal(message.Value, &event); err != nil {
		c.log.Error("unreadable payment event", "offset", message.Offset, "error", err)
		return
	}
// @@ since consume-events until decline-reason
	if err := c.handler.ApplyPaymentEvent(ctx, event.OrderID, event.Kind); err != nil {
// @@ end
// @@ since decline-reason
	if err := c.handler.ApplyPaymentEvent(ctx, event.OrderID, event.Kind, event.Reason); err != nil {
// @@ end
		c.log.Warn("payment event not applied", "order", event.OrderID, "type", event.Kind, "error", err)
	}
}
