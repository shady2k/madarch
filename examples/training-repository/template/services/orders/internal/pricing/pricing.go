// Package pricing turns order lines into money. All amounts are cents.
package pricing

// LineTotal is the price of one order line before discount and tax.
func LineTotal(unitCents int64, quantity int) int64 {
	return unitCents * int64(quantity)
}

// Discount returns the amount to take off amountCents for a percentage that
// the caller chose (BR-1).
// @@ since pricing until tax-rounding
func Discount(amountCents int64, percent int) int64 {
	return amountCents * int64(percent) / 100
}

// @@ end
// @@ since tax-rounding until discount-cap
func Discount(amountCents int64, percent int) int64 {
	return percentOf(amountCents, percent)
}

// @@ end
// @@ since discount-cap
// It never takes off more than the amount itself.
func Discount(amountCents int64, percent int) int64 {
	if amountCents <= 0 || percent <= 0 {
		return 0
	}
	if percent > 100 {
		percent = 100
	}
	return percentOf(amountCents, percent)
}

// @@ end
// @@ since tax-rounding until half-up
// percentOf is amount * percent / 100, cut off at the cent.
func percentOf(amountCents int64, percent int) int64 {
	return amountCents * int64(percent) / 100
}
// @@ end
// @@ since half-up until tax-bp
// percentOf is amount * percent / 100, rounded half up.
func percentOf(amountCents int64, percent int) int64 {
	return (amountCents*int64(percent) + 50) / 100
}
// @@ end
// @@ since tax-bp until rounding-mode
// percentOf is amount * percent / 100, rounded half up, worked out in basis
// points so that the tax rate can share the arithmetic.
func percentOf(amountCents int64, percent int) int64 {
	return (amountCents*int64(percent)*100 + 5000) / 10000
}
// @@ end
// @@ since rounding-mode
// percentOf is amount * percent / 100, rounded half away from zero, worked out
// in basis points so that the tax rate can share the arithmetic.
func percentOf(amountCents int64, percent int) int64 {
	product := amountCents * int64(percent) * 100
	if product < 0 {
		return -((-product + 5000) / 10000)
	}
	return (product + 5000) / 10000
}
// @@ end
