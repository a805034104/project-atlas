package demo.reflect;

import org.springframework.stereotype.Component;

@Component("reportJob")
public class ReportJob {
  public String execute() {
    return "report done";
  }
}
