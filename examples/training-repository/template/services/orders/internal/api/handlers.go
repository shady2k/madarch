package api

import (
	"context"
	"encoding/json"
	"errors"
// @@ since errors
	"log/slog"
// @@ end
	"net/http"
// @@ since paging
	"strconv"
// @@ end
	"time"

	"training.example/orders/internal/application"
// @@ since move-domain
	"training.example/orders/internal/domain"
// @@ end
// @@ until move-domain
	"training.example/orders/src"
// @@ end
)

// OrderService is what the handlers need from the application layer.
// application.Service implements it.
type OrderService interface {
	Place(ctx context.Context, cmd application.PlaceOrder) (domain.Order, error)
// @@ since read-orders
	Get(ctx context.Context, id string) (domain.Order, error)
// @@ end
// @@ since read-orders until paging
	List(ctx context.Context) ([]domain.Order, error)
// @@ end
// @@ since paging
	List(ctx context.Context, filter application.ListFilter) ([]domain.Order, error)
// @@ end
// @@ since cancel-ship until decline-reason
	Cancel(ctx context.Context, id string) (domain.Order, error)
// @@ end
// @@ since decline-reason
	Cancel(ctx context.Context, id, reason string) (domain.Order, error)
// @@ end
// @@ since cancel-ship
	Ship(ctx context.Context, id string) (domain.Order, error)
// @@ end
// @@ since export until paging
	ForEach(ctx context.Context, fn func(domain.Order) error) error
// @@ end
// @@ since paging
	ForEach(ctx context.Context, filter application.ListFilter, fn func(domain.Order) error) error
// @@ end
}

// OrderHandlers serves the /orders routes.
type OrderHandlers struct {
	svc OrderService
}

// NewOrderHandlers returns the handlers over svc.
func NewOrderHandlers(svc OrderService) *OrderHandlers {
	return &OrderHandlers{svc: svc}
}

type itemJSON struct {
	SKU        string `json:"sku"`
	Quantity   int    `json:"quantity"`
	PriceCents int64  `json:"priceCents"`
// @@ since tax-rounding
	ZeroRated  bool   `json:"zeroRated,omitempty"`
// @@ end
}

type placeRequest struct {
	Items []itemJSON `json:"items"`
// @@ until jwt

	CustomerID string `json:"customerId"`
// @@ end
// @@ since apply-promotion

	DiscountPercent int `json:"discountPercent"`
// @@ end
}

type orderJSON struct {
	ID         string     `json:"id"`
	CustomerID string     `json:"customerId"`
	Status     string     `json:"status"`
	Items      []itemJSON `json:"items"`

// @@ until preview
	TotalCents int64 `json:"totalCents"`
// @@ end
// @@ since preview
	SubtotalCents int64 `json:"subtotalCents"`
	DiscountCents int64 `json:"discountCents"`
	TaxCents      int64 `json:"taxCents"`
	TotalCents    int64 `json:"totalCents"`
// @@ end
// @@ since decline-reason

	CancelReason string `json:"cancelReason,omitempty"`
// @@ end

	CreatedAt time.Time `json:"createdAt"`
}

// @@ since paging
type listJSON struct {
	Orders []orderJSON `json:"orders"`
	// NextCursor is the id of the last order of the page; send it as "after" to
	// get the next page. It is empty when the page is empty.
	NextCursor string `json:"nextCursor,omitempty"`
}

// @@ end
func toItems(in []itemJSON) []domain.Item {
	items := make([]domain.Item, 0, len(in))
	for _, i := range in {
// @@ until tax-rounding
		items = append(items, domain.Item{SKU: i.SKU, Quantity: i.Quantity, PriceCents: i.PriceCents})
// @@ end
// @@ since tax-rounding
		items = append(items, domain.Item{SKU: i.SKU, Quantity: i.Quantity, PriceCents: i.PriceCents, ZeroRated: i.ZeroRated})
// @@ end
	}
	return items
}

func toJSON(o domain.Order) orderJSON {
	out := orderJSON{ID: o.ID, CustomerID: o.CustomerID, Status: string(o.Status), Items: make([]itemJSON, 0, len(o.Items)), CreatedAt: o.CreatedAt}
// @@ until preview
	out.TotalCents = o.Total
// @@ end
// @@ since preview
	out.SubtotalCents = o.Subtotal
	out.DiscountCents = o.Discount
	out.TaxCents = o.Tax
	out.TotalCents = o.Total
// @@ end
// @@ since decline-reason
	out.CancelReason = o.CancelReason
// @@ end
	for _, i := range o.Items {
// @@ until tax-rounding
		out.Items = append(out.Items, itemJSON{SKU: i.SKU, Quantity: i.Quantity, PriceCents: i.PriceCents})
// @@ end
// @@ since tax-rounding
		out.Items = append(out.Items, itemJSON{SKU: i.SKU, Quantity: i.Quantity, PriceCents: i.PriceCents, ZeroRated: i.ZeroRated})
// @@ end
	}
	return out
}

// Create places an order (POST /orders).
func (h *OrderHandlers) Create(w http.ResponseWriter, r *http.Request) {
	var req placeRequest
	if err := json.NewDecoder(r.Body).Decode(&req); err != nil {
		writeError(w, r, badRequest("the request body is not valid JSON"))
		return
	}
// @@ until jwt
	cmd := application.PlaceOrder{CustomerID: req.CustomerID, Items: toItems(req.Items)}
// @@ end
// @@ since jwt
	claims, _ := ClaimsFromContext(r.Context())
	cmd := application.PlaceOrder{CustomerID: claims.CustomerID, Items: toItems(req.Items)}
// @@ end
// @@ since apply-promotion
	cmd.DiscountPercent = req.DiscountPercent
// @@ end
// @@ since idempotent-place
	cmd.RequestID = r.Header.Get("Idempotency-Key")
// @@ end
	order, err := h.svc.Place(r.Context(), cmd)
	if err != nil {
		writeError(w, r, err)
		return
	}
	writeJSON(w, http.StatusCreated, toJSON(order))
}

// @@ since read-orders
// Get returns one order (GET /orders/{id}).
func (h *OrderHandlers) Get(w http.ResponseWriter, r *http.Request) {
	order, err := h.svc.Get(r.Context(), r.PathValue("id"))
	if err != nil {
		writeError(w, r, err)
		return
	}
// @@ since jwt
	if !canSee(r, order) {
		writeError(w, r, domain.ErrNotFound)
		return
	}
// @@ end
	writeJSON(w, http.StatusOK, toJSON(order))
}

// @@ end
// @@ since read-orders until paging
// List returns the orders (GET /orders).
func (h *OrderHandlers) List(w http.ResponseWriter, r *http.Request) {
	orders, err := h.svc.List(r.Context())
	if err != nil {
		writeError(w, r, err)
		return
	}
	out := make([]orderJSON, 0, len(orders))
	for _, o := range orders {
		out = append(out, toJSON(o))
	}
	writeJSON(w, http.StatusOK, out)
}

// @@ end
// @@ since paging
// List returns one page of orders (GET /orders?after=&limit=). A customer
// sees their own orders; support sees all of them.
func (h *OrderHandlers) List(w http.ResponseWriter, r *http.Request) {
	query := r.URL.Query()
	filter := application.ListFilter{AfterID: query.Get("after")}
	if raw := query.Get("limit"); raw != "" {
		limit, err := strconv.Atoi(raw)
		if err != nil || limit < 0 {
			writeError(w, r, badRequest("limit must be a whole number, zero or more"))
			return
		}
		filter.Limit = limit
	}
// @@ since customer-filter
	if claims, ok := ClaimsFromContext(r.Context()); ok && claims.Role != "support" {
		filter.CustomerID = claims.CustomerID
	}
// @@ end
	orders, err := h.svc.List(r.Context(), filter)
	if err != nil {
		writeError(w, r, err)
		return
	}
	body := listJSON{Orders: make([]orderJSON, 0, len(orders))}
	for _, o := range orders {
		body.Orders = append(body.Orders, toJSON(o))
		body.NextCursor = o.ID
	}
	writeJSON(w, http.StatusOK, body)
}

// @@ end
// @@ since cancel-ship until decline-reason
// Cancel cancels an order (POST /orders/{id}/cancel).
func (h *OrderHandlers) Cancel(w http.ResponseWriter, r *http.Request) {
	order, err := h.svc.Cancel(r.Context(), r.PathValue("id"))
	if err != nil {
		writeError(w, r, err)
		return
	}
	writeJSON(w, http.StatusOK, toJSON(order))
}

// @@ end
// @@ since decline-reason
// Cancel cancels an order (POST /orders/{id}/cancel). A customer may only
// cancel their own order; the optional body carries the reason.
func (h *OrderHandlers) Cancel(w http.ResponseWriter, r *http.Request) {
	id := r.PathValue("id")
	existing, err := h.svc.Get(r.Context(), id)
	if err != nil {
		writeError(w, r, err)
		return
	}
	if !canSee(r, existing) {
		writeError(w, r, domain.ErrNotFound)
		return
	}
	var body struct {
		Reason string `json:"reason"`
	}
	_ = json.NewDecoder(r.Body).Decode(&body)
	order, err := h.svc.Cancel(r.Context(), id, body.Reason)
	if err != nil {
		writeError(w, r, err)
		return
	}
	writeJSON(w, http.StatusOK, toJSON(order))
}

// @@ end
// @@ since cancel-ship
// Ship marks an order as shipped (POST /orders/{id}/ship); the router lets
// only support through.
func (h *OrderHandlers) Ship(w http.ResponseWriter, r *http.Request) {
	order, err := h.svc.Ship(r.Context(), r.PathValue("id"))
	if err != nil {
		writeError(w, r, err)
		return
	}
	writeJSON(w, http.StatusOK, toJSON(order))
}

// @@ end
// @@ since jwt
// canSee reports whether the caller may read the order: its owner and support may.
func canSee(r *http.Request, o domain.Order) bool {
	claims, ok := ClaimsFromContext(r.Context())
	return ok && (claims.Role == "support" || claims.CustomerID == o.CustomerID)
}

// @@ end
// requestError is a mistake in the request itself.
type requestError struct {
	message string
}

func (e requestError) Error() string { return e.message }

func badRequest(message string) error { return requestError{message: message} }

// @@ since errors
type errorBody struct {
	Error   string `json:"error"`
	Message string `json:"message"`
}

// @@ end
func writeJSON(w http.ResponseWriter, status int, body any) {
	w.Header().Set("Content-Type", "application/json")
	w.WriteHeader(status)
	_ = json.NewEncoder(w).Encode(body)
}

// @@ since place until errors
// writeError answers with the status that fits the error.
func writeError(w http.ResponseWriter, _ *http.Request, err error) {
	status := http.StatusInternalServerError
	var bad requestError
	if errors.As(err, &bad) {
		status = http.StatusBadRequest
	}
// @@ end
// @@ since read-orders until errors
	if errors.Is(err, domain.ErrNotFound) {
		status = http.StatusNotFound
	}
// @@ end
// @@ since place until errors
	http.Error(w, err.Error(), status)
}

// @@ end
// @@ since errors
// writeError answers with a JSON error body and the status that fits the
// error: the typed errors of the domain and application layers map to 4xx,
// anything else is logged and answered as a 500 without its details.
func writeError(w http.ResponseWriter, r *http.Request, err error) {
	var bad requestError
	switch {
	case errors.As(err, &bad):
		writeJSON(w, http.StatusBadRequest, errorBody{Error: "bad_request", Message: bad.message})
	case errors.Is(err, domain.ErrNotFound):
		writeJSON(w, http.StatusNotFound, errorBody{Error: "not_found", Message: "no such order"})
	case errors.Is(err, domain.ErrInvalidTransition):
		writeJSON(w, http.StatusConflict, errorBody{Error: "conflict", Message: err.Error()})
// @@ since validate
	case errors.Is(err, domain.ErrInvalidItems):
		writeJSON(w, http.StatusUnprocessableEntity, errorBody{Error: "invalid_items", Message: err.Error()})
// @@ end
// @@ since customers-check
	case errors.Is(err, application.ErrUnknownCustomer):
		writeJSON(w, http.StatusUnprocessableEntity, errorBody{Error: "unknown_customer", Message: err.Error()})
// @@ end
// @@ since discount-cap
	case errors.Is(err, application.ErrInvalidDiscount):
		writeJSON(w, http.StatusUnprocessableEntity, errorBody{Error: "invalid_discount", Message: err.Error()})
// @@ end
	default:
		slog.Error("request failed", "method", r.Method, "path", r.URL.Path, "error", err)
		writeJSON(w, http.StatusInternalServerError, errorBody{Error: "internal", Message: "internal error"})
	}
}
// @@ end
