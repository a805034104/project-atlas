package demo.reflect;

import java.lang.reflect.Method;
import org.springframework.context.ApplicationContext;
import org.springframework.stereotype.Service;

@Service
public class JobService {
  private final ApplicationContext context;

  public JobService(ApplicationContext context) {
    this.context = context;
  }

  public String runByName(String name) throws Exception {
    Object bean = context.getBean(name);
    Method execute = bean.getClass().getMethod("execute");
    return String.valueOf(execute.invoke(bean));
  }

  public String runLocal() throws Exception {
    Method audit = JobService.class.getMethod("audit");
    return String.valueOf(audit.invoke(this));
  }

  public String audit() {
    return "audited";
  }
}
