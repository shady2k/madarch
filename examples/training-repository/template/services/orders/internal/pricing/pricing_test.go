package pricing

import "testing"

func TestDiscount(t *testing.T) {
	cases := []struct {
		name    string
		amount  int64
		percent int
		want    int64
	}{
		{"ten percent of 10.00", 1000, 10, 100},
		{"no discount", 1000, 0, 0},
// @@ since half-up
		{"half a cent rounds up", 5, 10, 1},
// @@ end
// @@ since discount-cap
		{"more than 100 percent takes off the amount", 1000, 150, 1000},
		{"a negative percent takes off nothing", 1000, -5, 0},
// @@ end
	}
	for _, c := range cases {
		t.Run(c.name, func(t *testing.T) {
			if got := Discount(c.amount, c.percent); got != c.want {
				t.Errorf("Discount(%d, %d) = %d, want %d", c.amount, c.percent, got, c.want)
			}
		})
	}
}

func TestLineTotal(t *testing.T) {
	if got := LineTotal(1250, 3); got != 3750 {
		t.Errorf("LineTotal(1250, 3) = %d, want 3750", got)
	}
}

func TestTax(t *testing.T) {
	cases := []struct {
		name    string
		taxable int64
		want    int64
	}{
		{"eight percent of 10.00", 1000, 80},
// @@ since half-up
		{"rounds to the nearest cent", 62, 5},
// @@ end
// @@ since tax-zero
		{"nothing taxable", 0, 0},
		{"a negative amount is not taxed", -100, 0},
// @@ end
	}
	for _, c := range cases {
		t.Run(c.name, func(t *testing.T) {
			if got := Tax(c.taxable); got != c.want {
				t.Errorf("Tax(%d) = %d, want %d", c.taxable, got, c.want)
			}
		})
	}
}
// @@ since tax-rounding

func TestLineTax(t *testing.T) {
	if got := LineTax(1000, true); got != 0 {
		t.Errorf("a zero-rated line paid %d tax, want 0", got)
	}
	if got := LineTax(1000, false); got != 80 {
		t.Errorf("a standard line paid %d tax, want 80", got)
	}
}
// @@ end
