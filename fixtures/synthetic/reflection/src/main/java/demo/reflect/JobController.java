package demo.reflect;

import org.springframework.web.bind.annotation.GetMapping;
import org.springframework.web.bind.annotation.PathVariable;
import org.springframework.web.bind.annotation.RestController;

@RestController
public class JobController {
  private final JobService jobService;
  private final ReportJob reportJob;

  public JobController(JobService jobService, ReportJob reportJob) {
    this.jobService = jobService;
    this.reportJob = reportJob;
  }

  /** Reflection across classes: JobService.runByName ⇢ ReportJob.execute (no static path). */
  @GetMapping("/jobs/{name}/run")
  public String run(@PathVariable String name) throws Exception {
    return jobService.runByName(name);
  }

  /** Reflection inside one class: JobService.runLocal ⇢ JobService.audit (same class). */
  @GetMapping("/jobs/local")
  public String local() throws Exception {
    return jobService.runLocal();
  }

  /** Makes ReportJob.execute and JobService.audit steps of their own flows. */
  @GetMapping("/report")
  public String report() {
    return reportJob.execute() + jobService.audit();
  }
}
