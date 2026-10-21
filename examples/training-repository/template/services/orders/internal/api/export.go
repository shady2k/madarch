package api

import (
	"encoding/csv"
	"log/slog"
	"net/http"
	"strconv"
	"time"

// @@ since paging
	"training.example/orders/internal/application"
// @@ end
	"training.example/orders/internal/domain"
)

// Export streams every order as CSV (GET /orders/export). The router registers
// it outside the auth group.
func (h *OrderHandlers) Export(w http.ResponseWriter, r *http.Request) {
	w.Header().Set("Content-Type", "text/csv")
	w.Header().Set("Content-Disposition", `attachment; filename="orders.csv"`)
	out := csv.NewWriter(w)
	_ = out.Write([]string{"id", "customer_id", "status", "total_cents", "created_at"})
	write := func(o domain.Order) error {
		return out.Write([]string{o.ID, o.CustomerID, string(o.Status), strconv.FormatInt(o.Total, 10), o.CreatedAt.UTC().Format(time.RFC3339)})
	}
// @@ until paging
	err := h.svc.ForEach(r.Context(), write)
// @@ end
// @@ since paging
	err := h.svc.ForEach(r.Context(), application.ListFilter{}, write)
// @@ end
	out.Flush()
	if err != nil {
		// The status line is already sent; all that is left is to say so in the log.
		slog.Error("order export stopped", "error", err)
	}
}
