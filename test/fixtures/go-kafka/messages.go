package api
import (
 "context"
 "github.com/segmentio/kafka-go"
)
func Build() kafka.Message { return kafka.Message{Topic: "events", Value: []byte("draft")} }
func Publish(w *kafka.Writer) { w.WriteMessages(context.Background(), kafka.Message{Topic: "events", Value: []byte("sent")}) }
