package demo.consumer;

import java.time.Duration;
import org.springframework.beans.factory.annotation.Autowired;
import org.springframework.boot.SpringApplication;
import org.springframework.boot.autoconfigure.SpringBootApplication;
import org.springframework.context.annotation.Bean;
import org.springframework.context.annotation.Configuration;
import org.springframework.data.redis.connection.RedisConnectionFactory;
import org.springframework.data.redis.connection.stream.MapRecord;
import org.springframework.data.redis.connection.stream.ReadOffset;
import org.springframework.data.redis.connection.stream.StreamOffset;
import org.springframework.data.redis.stream.StreamListener;
import org.springframework.data.redis.stream.StreamMessageListenerContainer;
import org.springframework.data.redis.stream.StreamMessageListenerContainer.StreamMessageListenerContainerOptions;
import org.springframework.data.redis.stream.Subscription;
import org.springframework.stereotype.Component;
import org.springframework.stereotype.Service;

@SpringBootApplication
public class ConsumerApp {
  public static void main(String[] args) {
    SpringApplication.run(ConsumerApp.class, args);
  }
}

@Configuration
class StreamConfig {
  @Autowired private OrderStreamListener listener;

  @Bean(destroyMethod = "stop")
  StreamMessageListenerContainer<String, MapRecord<String, String, String>> container(RedisConnectionFactory factory) {
    StreamMessageListenerContainer<String, MapRecord<String, String, String>> container =
        StreamMessageListenerContainer.create(factory, StreamMessageListenerContainerOptions.builder().pollTimeout(Duration.ofSeconds(1)).build());
    container.start();
    return container;
  }

  @Bean
  Subscription subscription(StreamMessageListenerContainer<String, MapRecord<String, String, String>> container) {
    return container.receive(StreamOffset.create("stream:orders", ReadOffset.latest()), listener);
  }
}

@Component
class OrderStreamListener implements StreamListener<String, MapRecord<String, String, String>> {
  @Autowired private OrderHandler orderHandler;

  @Override
  public void onMessage(MapRecord<String, String, String> message) {
    orderHandler.handle(message.getValue().get("id"));
  }
}

@Service
class OrderHandler {
  public void handle(String id) {
    System.out.println("handled order " + id);
  }
}
