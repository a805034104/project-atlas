# Analyze / 分析

Atlas parses Java, Vue, JS and TS files locally with tree-sitter and applies Spring, Vue and Spring Cloud rules. This step needs no network access.

Atlas 使用 tree-sitter 在本地解析 Java、Vue、JS、TS 文件，并应用 Spring、Vue、Spring Cloud 规则。这一步不需要联网。

Typical result for RuoYi-Vue: about 150 HTTP endpoints, each with its full chain: filters, interceptors, permission checks, aspects, controller, service, mapper and SQL.
