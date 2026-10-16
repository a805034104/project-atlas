package demo.consumer;

import org.springframework.amqp.core.Binding;
import org.springframework.amqp.core.BindingBuilder;
import org.springframework.amqp.core.Queue;
import org.springframework.amqp.core.TopicExchange;
import org.springframework.amqp.rabbit.annotation.RabbitListener;
import org.springframework.beans.factory.annotation.Autowired;
import org.springframework.boot.SpringApplication;
import org.springframework.boot.autoconfigure.SpringBootApplication;
import org.springframework.context.annotation.Bean;
import org.springframework.context.annotation.Configuration;
import org.springframework.stereotype.Component;
import org.springframework.stereotype.Service;

@SpringBootApplication
public class ConsumerApp {
  public static void main(String[] args) {
    SpringApplication.run(ConsumerApp.class, args);
  }
}

@Configuration
class RabbitConfig {
  @Bean
  public TopicExchange orderExchange() {
    return new TopicExchange("order.topic");
  }

  @Bean
  public Queue orderQueue() {
    return new Queue("order.q");
  }

  @Bean
  public Binding orderBinding(Queue orderQueue, TopicExchange orderExchange) {
    return BindingBuilder.bind(orderQueue).to(orderExchange).with("order.*");
  }
}

@Component
class OrderListener {
  @Autowired private OrderHandler orderHandler;

  @RabbitListener(queues = "order.q")
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
