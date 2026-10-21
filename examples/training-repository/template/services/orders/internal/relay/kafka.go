package relay

import (
	"context"
	"strings"

	"github.com/segmentio/kafka-go"
)

// KafkaPublisher publishes to Kafka with segmentio/kafka-go.
type KafkaPublisher struct {
	writer *kafka.Writer
}

// NewKafkaPublisher returns a publisher for a comma-separated broker list.
// Messages with the same key (the order id) go to the same partition, so one
// order's messages stay in order.
func NewKafkaPublisher(brokers string) *KafkaPublisher {
	return &KafkaPublisher{writer: &kafka.Writer{
		Addr:         kafka.TCP(strings.Split(brokers, ",")...),
		Balancer:     &kafka.Hash{},
		RequiredAcks: kafka.RequireAll,
	}}
}

// Publish sends one message and waits for the brokers' acknowledgement.
func (p *KafkaPublisher) Publish(ctx context.Context, topic, key string, payload []byte) error {
	return p.writer.WriteMessages(ctx, kafka.Message{Topic: topic, Key: []byte(key), Value: payload})
}

// Close flushes and closes the writer.
func (p *KafkaPublisher) Close() error {
	return p.writer.Close()
}
