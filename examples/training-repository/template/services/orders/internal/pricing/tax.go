package pricing

// @@ since half-up until tax-bp
import "math"

// @@ end
// @@ since pricing until tax-bp
// TaxRate is the sales tax: 8% (BR-2 in docs/requirements.md).
const TaxRate = 0.08

// @@ end
// @@ since tax-bp
// TaxRateBasisPoints is the sales tax: 800 basis points, 8% (BR-2 in docs/requirements.md).
const TaxRateBasisPoints = 800

// @@ end
// Tax returns the tax on a taxable amount in cents.
// @@ since pricing until half-up
func Tax(taxableCents int64) int64 {
	return int64(float64(taxableCents) * TaxRate)
}

// @@ end
// @@ since half-up until tax-zero
func Tax(taxableCents int64) int64 {
	return int64(math.Round(float64(taxableCents) * TaxRate))
}

// @@ end
// @@ since tax-zero until tax-bp
func Tax(taxableCents int64) int64 {
	if taxableCents <= 0 {
		return 0
	}
	return int64(math.Round(float64(taxableCents) * TaxRate))
}

// @@ end
// @@ since tax-bp until rounding-mode
func Tax(taxableCents int64) int64 {
	if taxableCents <= 0 {
		return 0
	}
	return (taxableCents*TaxRateBasisPoints + 5000) / 10000
}

// @@ end
// @@ since rounding-mode
// The result is rounded half away from zero, like the discount.
func Tax(taxableCents int64) int64 {
	if taxableCents <= 0 {
		return 0
	}
	return (taxableCents*TaxRateBasisPoints + 5000) / 10000
}

// @@ end
// @@ since tax-rounding
// LineTax returns the tax on one line after its discount; zero-rated lines pay none.
func LineTax(lineCents int64, zeroRated bool) int64 {
	if zeroRated {
		return 0
	}
	return Tax(lineCents)
}
// @@ end
