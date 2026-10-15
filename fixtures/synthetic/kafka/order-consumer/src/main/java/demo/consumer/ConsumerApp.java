package demo.consumer;

import org.springframework.beans.factory.annotation.Autowired;
import org.springframework.boot.SpringApplication;
import org.springframework.boot.autoconfigure.SpringBootApplication;
import org.springframework.kafka.annotation.KafkaListener;
import org.springframework.stereotype.Component;
import org.springframework.stereotype.Service;

@SpringBootApplication
public class ConsumerApp {
  public static void main(String[] args) {
    SpringApplication.run(ConsumerApp.class, args);
  }
}

@Component
class OrderListener {
  @Autowired private OrderHandler orderHandler;

  @KafkaListener(topics = "order-created")
  public void onCreated(String id) {
    orderHandler.handle(id);
  }
}

@Service
class OrderHandler {
  public void handle(String id) {
    System.out.println("handled order " + id);
  }
}
