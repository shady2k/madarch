// Package api is the HTTP layer of the promotions service.
package api

import (
	"context"
	"encoding/json"
	"errors"
	"log/slog"
	"net/http"
	"time"

	"training.example/promotions/internal/discount"
	"training.example/promotions/internal/store"
)

// Promotions is what the handler needs from storage; store.Repository implements it.
type Promotions interface {
	FindActive(ctx context.Context, code string, now time.Time) (store.Promotion, error)
}

// Handler serves /internal/apply and /healthz.
type Handler struct {
	promotions Promotions
	log        *slog.Logger
	now        func() time.Time
}

// New returns the handler.
func New(promotions Promotions, log *slog.Logger, now func() time.Time) *Handler {
	return &Handler{promotions: promotions, log: log, now: now}
}

// Routes registers the routes.
func (h *Handler) Routes() http.Handler {
	mux := http.NewServeMux()
	mux.HandleFunc("POST /internal/apply", h.apply)
	mux.HandleFunc("GET /healthz", func(w http.ResponseWriter, _ *http.Request) {
		writeJSON(w, http.StatusOK, map[string]string{"status": "ok"})
	})
	return mux
}

type applyRequest struct {
	Code          string `json:"code"`
	SubtotalCents int64  `json:"subtotalCents"`
}

type applyResponse struct {
	Code          string `json:"code"`
	DiscountCents int64  `json:"discountCents"`
	// Percent is the discount as a percentage of the subtotal, rounded to the
	// nearest whole percent: orders accepts only percentages.
	Percent int64 `json:"percent"`
}

func (h *Handler) apply(w http.ResponseWriter, r *http.Request) {
	var req applyRequest
	if err := json.NewDecoder(r.Body).Decode(&req); err != nil || req.Code == "" || req.SubtotalCents <= 0 {
		writeJSON(w, http.StatusBadRequest, map[string]string{"error": "bad_request"})
		return
	}
	promotion, err := h.promotions.FindActive(r.Context(), req.Code, h.now())
	if errors.Is(err, store.ErrNotFound) {
		writeJSON(w, http.StatusNotFound, map[string]string{"error": "unknown_code"})
		return
	}
	if err != nil {
		h.log.Error("promotion lookup failed", "code", req.Code, "error", err)
		writeJSON(w, http.StatusInternalServerError, map[string]string{"error": "internal"})
		return
	}
	strategy, err := discount.For(promotion.Kind, promotion.Value, promotion.MinCents)
	if err != nil {
		h.log.Error("promotion has an unknown kind", "code", req.Code, "error", err)
		writeJSON(w, http.StatusInternalServerError, map[string]string{"error": "internal"})
		return
	}
	cents := strategy.Discount(req.SubtotalCents)
	if cents == 0 {
		writeJSON(w, http.StatusUnprocessableEntity, map[string]string{"error": "does_not_apply"})
		return
	}
	writeJSON(w, http.StatusOK, applyResponse{
		Code:          req.Code,
		DiscountCents: cents,
		Percent:       (cents*100 + req.SubtotalCents/2) / req.SubtotalCents,
	})
}

func writeJSON(w http.ResponseWriter, status int, body any) {
	w.Header().Set("Content-Type", "application/json")
	w.WriteHeader(status)
	_ = json.NewEncoder(w).Encode(body)
}
