// Package discount holds the ways a promotion code reduces a subtotal. Every
// way is a Strategy; the rest of the service only knows the interface.
package discount

import (
	"fmt"
// @@ until promo-round
	"math"
// @@ end
)

// Strategy computes the discount a promotion gives on a subtotal, in cents.
// It never returns more than the subtotal and never less than zero.
type Strategy interface {
	Discount(subtotalCents int64) int64
}

// Percent takes a percentage off the subtotal.
type Percent struct {
	// Percent is 10 for ten percent.
	Percent int64
}

// @@ until promo-round
// Discount rounds to the nearest cent.
func (p Percent) Discount(subtotalCents int64) int64 {
	return clamp(int64(math.Round(float64(subtotalCents)*float64(p.Percent)/100)), subtotalCents)
}

// @@ end
// @@ since promo-round
// Discount rounds down, so a code never gives more than it promises.
func (p Percent) Discount(subtotalCents int64) int64 {
	return clamp(subtotalCents*p.Percent/100, subtotalCents)
}

// @@ end
// @@ since strategies
// FixedAmount takes a fixed amount off, but never more than the subtotal.
type FixedAmount struct {
	Cents int64
}

// Discount returns the fixed amount, capped at the subtotal.
func (f FixedAmount) Discount(subtotalCents int64) int64 {
	return clamp(f.Cents, subtotalCents)
}

// Threshold takes a percentage off, but only once the subtotal reaches a minimum spend.
type Threshold struct {
	MinCents int64
	Percent  int64
}

// Discount is zero below the minimum spend and the percentage above it.
func (t Threshold) Discount(subtotalCents int64) int64 {
	if subtotalCents < t.MinCents {
		return 0
	}
	return Percent{Percent: t.Percent}.Discount(subtotalCents)
}

// @@ end
func clamp(discount, subtotal int64) int64 {
	if discount < 0 {
		return 0
	}
	if discount > subtotal {
		return subtotal
	}
	return discount
}

// For builds the strategy a promotion row names. kind is the row's kind, value
// its value, minCents its minimum spend (zero when there is none).
func For(kind string, value, minCents int64) (Strategy, error) {
	switch kind {
	case "percent":
		return Percent{Percent: value}, nil
// @@ since strategies
	case "fixed":
		return FixedAmount{Cents: value}, nil
	case "threshold":
		return Threshold{MinCents: minCents, Percent: value}, nil
// @@ end
	default:
		return nil, fmt.Errorf("unknown promotion kind %q", kind)
	}
}
