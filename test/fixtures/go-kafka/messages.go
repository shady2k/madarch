package api
import (
 "context"
 "github.com/segmentio/kafka-go"
)
func Build() kafka.Message { return kafka.Message{Topic: "events", Value: []byte("draft")} }
func Publish(w *kafka.Writer) { w.WriteMessages(context.Background(), kafka.Message{Topic: "events", Value: []byte("sent")}) }

func PublishDecoys(w *kafka.Writer) {
 w.WriteMessages(context.Background(), kafka.Message{
  /* Topic: "ghost" */
  Value: []byte("Topic: \"ghost\""),
  Headers: []kafka.Header{{Key: "Topic", Value: []byte("ghost")}},
  Topic: "events",
 })
}
