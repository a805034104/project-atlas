package demo.producer;

import org.springframework.beans.factory.annotation.Autowired;
import org.springframework.boot.SpringApplication;
import org.springframework.boot.autoconfigure.SpringBootApplication;
import org.springframework.kafka.core.KafkaTemplate;
import org.springframework.stereotype.Service;
import org.springframework.web.bind.annotation.PathVariable;
import org.springframework.web.bind.annotation.PostMapping;
import org.springframework.web.bind.annotation.RestController;

@SpringBootApplication
public class ProducerApp {
  public static void main(String[] args) {
    SpringApplication.run(ProducerApp.class, args);
  }
}

@RestController
class OrderController {
  @Autowired private OrderPublisher orderPublisher;

  @PostMapping("/orders/{id}")
  public String create(@PathVariable String id) throws Exception {
    orderPublisher.publish(id);
    return id;
  }
}

@Service
class OrderPublisher {
  static final String TOPIC = "order-created";

  @Autowired private KafkaTemplate<String, String> kafkaTemplate;

  public void publish(String id) throws Exception {
    kafkaTemplate.send(TOPIC, id).get();
  }
}
