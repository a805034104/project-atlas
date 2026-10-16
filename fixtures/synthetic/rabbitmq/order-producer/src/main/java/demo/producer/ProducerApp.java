package demo.producer;

import org.springframework.amqp.rabbit.core.RabbitTemplate;
import org.springframework.beans.factory.annotation.Autowired;
import org.springframework.boot.SpringApplication;
import org.springframework.boot.autoconfigure.SpringBootApplication;
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
  public String create(@PathVariable String id) {
    orderPublisher.publish(id);
    return id;
  }
}

@Service
class OrderPublisher {
  static final String EXCHANGE = "order.topic";
  static final String ROUTING_KEY = "order.created";

  @Autowired private RabbitTemplate rabbitTemplate;

  public void publish(String id) {
    rabbitTemplate.convertAndSend(EXCHANGE, ROUTING_KEY, id);
  }
}
