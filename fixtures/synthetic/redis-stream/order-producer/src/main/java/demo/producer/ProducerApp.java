package demo.producer;

import java.util.Map;
import org.springframework.beans.factory.annotation.Autowired;
import org.springframework.boot.SpringApplication;
import org.springframework.boot.autoconfigure.SpringBootApplication;
import org.springframework.data.redis.connection.stream.StreamRecords;
import org.springframework.data.redis.core.StringRedisTemplate;
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
    return orderPublisher.publish(id);
  }
}

@Service
class OrderPublisher {
  static final String STREAM = "stream:orders";

  @Autowired private StringRedisTemplate redisTemplate;

  public String publish(String id) {
    return redisTemplate.opsForStream().add(StreamRecords.newRecord().in(STREAM).ofMap(Map.of("id", id))).getValue();
  }
}
