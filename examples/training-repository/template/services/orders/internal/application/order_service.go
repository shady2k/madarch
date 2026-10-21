// Package application holds the order use cases. It talks to storage through
// the OrderStore interface and to nothing else; cmd/orders/main.go injects the
// implementations.
package application

import (
	"context"
	"crypto/rand"
	"encoding/hex"
// @@ since errors
	"errors"
// @@ end
// @@ since cancel-ship
	"fmt"
// @@ end
// @@ since trim-ids
	"strings"
// @@ end
	"time"

// @@ since move-domain
	"training.example/orders/internal/domain"
// @@ end
// @@ since request-id-log
	"training.example/orders/internal/logging"
// @@ end
// @@ since pricing
	"training.example/orders/internal/pricing"
// @@ end
// @@ until move-domain
	"training.example/orders/src"
// @@ end
)

// @@ since paging
const (
	defaultPageSize = 50
	maxPageSize     = 200
)

// @@ end
// @@ since deadlines
// callTimeout bounds one use case, storage calls included.
const callTimeout = 5 * time.Second

// @@ end
// @@ since batch-delete
// retentionBatch is how many expired orders one round of the retention job removes.
const retentionBatch = 100

// @@ end
// @@ since errors
var (
	// ErrUnknownCustomer is returned when an order names a customer that does not exist.
	ErrUnknownCustomer = errors.New("unknown customer")
	// ErrInvalidDiscount is returned when the discount percentage is outside 0..100.
	ErrInvalidDiscount = errors.New("discount percent must be between 0 and 100")
	// ErrUnknownPaymentEvent is returned for a payment event kind the service does not map.
	ErrUnknownPaymentEvent = errors.New("unknown payment event")
)

// @@ end
// OrderStore is the storage the service needs. store.OrderRepository
// implements it on database/sql; the tests use an in-memory fake.
// @@ since outbox-write
//
// Every write queues an OrderChanged message in the outbox, in the same
// transaction as the change (docs/adr/0002-outbox.md).
// @@ end
type OrderStore interface {
// @@ since place until cancel-ship
	// Save stores the order with its lines.
	Save(ctx context.Context, order domain.Order) error
// @@ end
// @@ since cancel-ship
	// Create inserts the order and its lines in one transaction.
	Create(ctx context.Context, order domain.Order) error
	// Save updates the order.
	Save(ctx context.Context, order domain.Order) error
// @@ end
// @@ since read-orders
	// Get returns the order or domain.ErrNotFound.
	Get(ctx context.Context, id string) (domain.Order, error)
// @@ end
// @@ since read-orders until paging
	// List returns every order, newest first.
	List(ctx context.Context) ([]domain.Order, error)
// @@ end
// @@ since paging
	// List returns one page of orders, oldest first.
	List(ctx context.Context, filter ListFilter) ([]domain.Order, error)
// @@ end
// @@ since idempotent-place
	// FindByRequestID returns the order a customer already placed with the
	// request id, or domain.ErrNotFound.
	FindByRequestID(ctx context.Context, customerID, requestID string) (domain.Order, error)
// @@ end
// @@ since customers-check
	// CustomerExists reports whether the customer is known.
	CustomerExists(ctx context.Context, id string) (bool, error)
// @@ end
// @@ since expiry
	// ListCreatedBefore returns up to limit orders created before cutoff that are not shipped.
	ListCreatedBefore(ctx context.Context, cutoff time.Time, limit int) ([]domain.Order, error)
	// Delete removes the orders with the given ids.
	Delete(ctx context.Context, ids []string) error
// @@ end
}

// @@ since metrics
// Metrics is what the service reports; api.Metrics implements it.
type Metrics interface {
	// OrderCreated counts one placed order.
	OrderCreated()
	// Transitioned counts one order that reached the given status.
	Transitioned(to domain.Status)
// @@ end
// @@ since expiry
	// Purged counts orders removed by the retention job.
	Purged(n int)
// @@ end
// @@ since metrics
}

// @@ end
// PlaceOrder is the request to place an order.
type PlaceOrder struct {
	CustomerID string
	Items      []domain.Item
// @@ since apply-promotion

	// DiscountPercent is the percentage the caller (checkout) chose, after
	// asking the promotions service. BR-1: orders applies whatever it is given.
	DiscountPercent int
// @@ end
// @@ since idempotent-place

	// RequestID is the client's idempotency key: placing twice with the same
	// request id returns the first order.
	RequestID string
// @@ end
}

// @@ since paging
// ListFilter narrows and pages the order list.
type ListFilter struct {
	// AfterID is the cursor: only orders after this one are returned.
	AfterID string
	// Limit is the page size; 0 means the default.
	Limit int
// @@ since customer-filter
	// CustomerID lists only this customer's orders when set.
	CustomerID string
// @@ end
}

// @@ end
// Service runs the order use cases.
type Service struct {
	// store holds the orders.
	store OrderStore
// @@ since metrics
	// metrics counts what happens.
	metrics Metrics
// @@ end
	// now is the clock.
	now func() time.Time
}

// NewService builds the service; now is injected so tests control the clock.
// @@ since place until metrics
func NewService(store OrderStore, now func() time.Time) *Service {
	return &Service{store: store, now: now}
}

// @@ end
// @@ since metrics
func NewService(store OrderStore, metrics Metrics, now func() time.Time) *Service {
	return &Service{store: store, metrics: metrics, now: now}
}

// @@ end
// Place prices and stores a new order in PendingPayment.
func (s *Service) Place(ctx context.Context, cmd PlaceOrder) (domain.Order, error) {
// @@ since deadlines
	ctx, cancel := context.WithTimeout(ctx, callTimeout)
	defer cancel()
// @@ end
// @@ since trim-ids
	cmd.CustomerID = strings.TrimSpace(cmd.CustomerID)
	cmd.RequestID = strings.TrimSpace(cmd.RequestID)
// @@ end
// @@ since validate
	if err := domain.ValidateItems(cmd.Items); err != nil {
		return domain.Order{}, err
	}
// @@ end
// @@ since discount-cap
	if cmd.DiscountPercent < 0 || cmd.DiscountPercent > 100 {
		return domain.Order{}, fmt.Errorf("%w: %d", ErrInvalidDiscount, cmd.DiscountPercent)
	}
// @@ end
// @@ since idempotent-place
	if cmd.RequestID != "" {
		existing, err := s.store.FindByRequestID(ctx, cmd.CustomerID, cmd.RequestID)
		if err == nil {
			return existing, nil
		}
		if !errors.Is(err, domain.ErrNotFound) {
			return domain.Order{}, err
		}
	}
// @@ end
// @@ since customers-check
	known, err := s.store.CustomerExists(ctx, cmd.CustomerID)
	if err != nil {
		return domain.Order{}, err
	}
	if !known {
		return domain.Order{}, ErrUnknownCustomer
	}
// @@ end
	order := domain.NewOrder(newID(), cmd.CustomerID, cmd.Items, s.now())
// @@ since idempotent-place
	order.RequestID = cmd.RequestID
// @@ end
// @@ since pricing until tax-rounding
	var total int64
	for _, item := range order.Items {
		total += pricing.LineTotal(item.PriceCents, item.Quantity)
	}
// @@ end
// @@ since pricing until apply-promotion
	total -= pricing.Discount(total, 10)
// @@ end
// @@ since apply-promotion until tax-rounding
	total -= pricing.Discount(total, cmd.DiscountPercent)
// @@ end
// @@ since pricing until tax-rounding
	total += pricing.Tax(total)
	order.Total = total
// @@ end
// @@ since tax-rounding
	// Discount and tax are computed per line, then added up (BR-1, BR-2).
	var subtotal, discounts, tax int64
	for _, item := range order.Items {
		gross := pricing.LineTotal(item.PriceCents, item.Quantity)
		discount := pricing.Discount(gross, cmd.DiscountPercent)
		subtotal += gross
		discounts += discount
		tax += pricing.LineTax(gross-discount, item.ZeroRated)
	}
	order.Total = subtotal - discounts + tax
// @@ end
// @@ since preview
	order.Subtotal, order.Discount, order.Tax = subtotal, discounts, tax
// @@ end
// @@ since place until cancel-ship
	if err := s.store.Save(ctx, order); err != nil {
		return domain.Order{}, err
	}
// @@ end
// @@ since cancel-ship
	if err := s.store.Create(ctx, order); err != nil {
		return domain.Order{}, fmt.Errorf("create order %s: %w", order.ID, err)
	}
// @@ end
// @@ since metrics
	s.metrics.OrderCreated()
// @@ end
// @@ since request-id-log
	logging.FromContext(ctx).Info("order placed", "order", order.ID, "customer", order.CustomerID, "total", order.Total)
// @@ end
	return order, nil
}

// @@ since read-orders
// Get returns one order.
func (s *Service) Get(ctx context.Context, id string) (domain.Order, error) {
// @@ until trim-ids
	return s.store.Get(ctx, id)
// @@ end
// @@ since trim-ids
	return s.store.Get(ctx, strings.TrimSpace(id))
// @@ end
}

// @@ end
// @@ since read-orders until paging
// List returns every order.
func (s *Service) List(ctx context.Context) ([]domain.Order, error) {
	return s.store.List(ctx)
}

// @@ end
// @@ since paging
// List returns one page of orders.
func (s *Service) List(ctx context.Context, filter ListFilter) ([]domain.Order, error) {
	if filter.Limit <= 0 || filter.Limit > maxPageSize {
		filter.Limit = defaultPageSize
	}
	return s.store.List(ctx, filter)
}

// @@ end
// @@ since export until paging
// ForEach calls fn for every order.
func (s *Service) ForEach(ctx context.Context, fn func(domain.Order) error) error {
	orders, err := s.store.List(ctx)
	if err != nil {
		return err
	}
	for _, order := range orders {
		if err := fn(order); err != nil {
			return err
		}
	}
	return nil
}

// @@ end
// @@ since paging
// ForEach calls fn for every order matching the filter, page after page.
func (s *Service) ForEach(ctx context.Context, filter ListFilter, fn func(domain.Order) error) error {
	filter.Limit = maxPageSize
	for {
		page, err := s.List(ctx, filter)
		if err != nil {
			return err
		}
		for _, order := range page {
			if err := fn(order); err != nil {
				return err
			}
		}
		if len(page) < filter.Limit {
			return nil
		}
		filter.AfterID = page[len(page)-1].ID
	}
}

// @@ end
// @@ since cancel-ship until decline-reason
// Apply feeds an event to the order and stores the result.
func (s *Service) Apply(ctx context.Context, id string, event domain.Event) (domain.Order, error) {
	order, err := s.store.Get(ctx, id)
	if err != nil {
		return domain.Order{}, err
	}
// @@ end
// @@ since cancel-ship until errors
	if !order.Apply(event, s.now()) {
		return domain.Order{}, fmt.Errorf("event %s is not allowed while the order is %s", event, order.Status)
	}
// @@ end
// @@ since errors until decline-reason
	if err := order.Apply(event, s.now()); err != nil {
		return domain.Order{}, err
	}
// @@ end
// @@ since cancel-ship until decline-reason
	if err := s.store.Save(ctx, order); err != nil {
		return domain.Order{}, err
	}
// @@ end
// @@ since decline-reason
// Apply feeds an event to the order and stores the result; note says why when
// the event cancels the order.
func (s *Service) Apply(ctx context.Context, id string, event domain.Event, note string) (domain.Order, error) {
// @@ end
// @@ since deadlines
	ctx, cancel := context.WithTimeout(ctx, callTimeout)
	defer cancel()
// @@ end
// @@ since decline-reason
	order, err := s.store.Get(ctx, id)
	if err != nil {
		return domain.Order{}, err
	}
	if err := order.Apply(event, s.now()); err != nil {
		return domain.Order{}, err
	}
	if order.Status == domain.Cancelled {
		order.CancelReason = note
	}
	if err := s.store.Save(ctx, order); err != nil {
		return domain.Order{}, err
	}
// @@ end
// @@ since log-transitions
	logging.FromContext(ctx).Info("order moved", "order", order.ID, "event", string(event), "status", string(order.Status))
// @@ end
// @@ since metrics
	s.metrics.Transitioned(order.Status)
// @@ end
// @@ since cancel-ship
	return order, nil
}

// @@ end
// @@ since cancel-ship until decline-reason
// Cancel cancels an order on a person's request.
func (s *Service) Cancel(ctx context.Context, id string) (domain.Order, error) {
	return s.Apply(ctx, id, domain.CancelRequested)
}

// Ship marks an order as handed to the carrier.
func (s *Service) Ship(ctx context.Context, id string) (domain.Order, error) {
	return s.Apply(ctx, id, domain.ShipmentDispatched)
}

// @@ end
// @@ since decline-reason
// Cancel cancels an order on a person's request; reason is kept on the order.
func (s *Service) Cancel(ctx context.Context, id, reason string) (domain.Order, error) {
	return s.Apply(ctx, id, domain.CancelRequested, reason)
}

// Ship marks an order as handed to the carrier.
func (s *Service) Ship(ctx context.Context, id string) (domain.Order, error) {
	return s.Apply(ctx, id, domain.ShipmentDispatched, "")
}

// @@ end
// @@ since consume-events until decline-reason
// ApplyPaymentEvent maps an event of the payments topic to an order event.
func (s *Service) ApplyPaymentEvent(ctx context.Context, orderID, kind string) error {
// @@ end
// @@ since decline-reason
// ApplyPaymentEvent maps an event of the payments topic to an order event;
// note carries the decline reason of a failed payment.
func (s *Service) ApplyPaymentEvent(ctx context.Context, orderID, kind, note string) error {
// @@ end
// @@ since consume-events
	var event domain.Event
	switch kind {
	case "payment.captured":
		event = domain.PaymentCaptured
	case "payment.failed":
		event = domain.PaymentFailed
// @@ end
// @@ since refunded-status
	case "payment.refunded":
		event = domain.PaymentRefunded
// @@ end
// @@ since consume-events until errors
	default:
		return fmt.Errorf("payment event %q is not known", kind)
// @@ end
// @@ since errors
	default:
		return fmt.Errorf("%w: %q", ErrUnknownPaymentEvent, kind)
// @@ end
// @@ since consume-events
	}
// @@ end
// @@ since duplicate-events
	if done, err := s.alreadyApplied(ctx, orderID, event); err != nil || done {
		return err
	}
// @@ end
// @@ since consume-events until decline-reason
	_, err := s.Apply(ctx, orderID, event)
// @@ end
// @@ since decline-reason
	_, err := s.Apply(ctx, orderID, event, note)
// @@ end
// @@ since consume-events
	return err
}

// @@ end
// @@ since duplicate-events
// alreadyApplied reports whether the order already is where the event would take it.
func (s *Service) alreadyApplied(ctx context.Context, orderID string, event domain.Event) (bool, error) {
	order, err := s.store.Get(ctx, orderID)
	if err != nil {
		return false, err
	}
	outcome, known := domain.Outcome(event)
	return known && order.Status == outcome, nil
}

// @@ end
// @@ since expiry until batch-delete
// RunRetentionJob removes the orders that expired and returns how many.
func (s *Service) RunRetentionJob(ctx context.Context) (int, error) {
	now := s.now()
	candidates, err := s.store.ListCreatedBefore(ctx, now.AddDate(0, 0, -domain.ExpiryDays), 1000)
	if err != nil {
		return 0, err
	}
	expired := domain.PurgeExpired(candidates, now)
	ids := make([]string, 0, len(expired))
	for _, order := range expired {
		ids = append(ids, order.ID)
	}
	if err := s.store.Delete(ctx, ids); err != nil {
		return 0, err
	}
	s.metrics.Purged(len(ids))
	return len(ids), nil
}

// @@ end
// @@ since batch-delete
// RunRetentionJob removes the orders that expired, a batch at a time,
// and returns how many it removed.
func (s *Service) RunRetentionJob(ctx context.Context) (int, error) {
	removed := 0
	for {
		now := s.now()
		candidates, err := s.store.ListCreatedBefore(ctx, now.AddDate(0, 0, -domain.ExpiryDays), retentionBatch)
		if err != nil {
			return removed, err
		}
		expired := domain.PurgeExpired(candidates, now)
		if len(expired) == 0 {
			return removed, nil
		}
		ids := make([]string, 0, len(expired))
		for _, order := range expired {
			ids = append(ids, order.ID)
		}
		if err := s.store.Delete(ctx, ids); err != nil {
			return removed, err
		}
		removed += len(ids)
		s.metrics.Purged(len(ids))
	}
}

// @@ end
// newID returns a random order id.
func newID() string {
	b := make([]byte, 8)
	if _, err := rand.Read(b); err != nil {
		panic(err)
	}
	return "ord_" + hex.EncodeToString(b)
}
