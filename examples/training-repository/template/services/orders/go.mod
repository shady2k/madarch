module training.example/orders

go 1.22

require (
// @@ since jwt
	github.com/golang-jwt/jwt/v5 v5.2.1
// @@ end
	github.com/lib/pq v1.10.9
// @@ since relay
	github.com/segmentio/kafka-go v0.4.47
// @@ end
)
// @@ since relay

require (
	github.com/klauspost/compress v1.15.9 // indirect
	github.com/pierrec/lz4/v4 v4.1.15 // indirect
)
// @@ end
