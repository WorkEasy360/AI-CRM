# ---------------------------------------------------------------------------
# CloudFront in front of the ALB.
#
# Caching policy: authenticated pages and the API are never cached at the edge
# (the app also sends Cache-Control: no-store and a per-request CSP nonce).
# Only content-hashed Next.js static assets and a couple of well-known files
# use the CachingOptimized policy.
#
# Every behaviour forwards the viewer Host header (Managed-AllViewer). This is
# required twice over: Django's ALLOWED_HOSTS is app_domain, and CloudFront
# validates the ALB's certificate against the forwarded Host header rather
# than the ALB's own DNS name.
# ---------------------------------------------------------------------------

data "aws_cloudfront_cache_policy" "caching_optimized" {
  name = "Managed-CachingOptimized"
}

data "aws_cloudfront_cache_policy" "caching_disabled" {
  name = "Managed-CachingDisabled"
}

data "aws_cloudfront_origin_request_policy" "all_viewer" {
  name = "Managed-AllViewer"
}

locals {
  cloudfront_origin_id = "${local.name}-alb"
  all_methods          = ["GET", "HEAD", "OPTIONS", "PUT", "POST", "PATCH", "DELETE"]
  read_methods         = ["GET", "HEAD", "OPTIONS"]
  cached_methods       = ["GET", "HEAD"]
  static_paths         = ["/_next/static/*", "/favicon.ico", "/robots.txt"]
  api_paths            = ["/api/*", "/_allauth/*"]
}

resource "aws_cloudfront_distribution" "this" {
  enabled         = true
  is_ipv6_enabled = true
  comment         = "${local.name} edge"
  aliases         = [var.app_domain]
  price_class     = var.cloudfront_price_class
  http_version    = "http2and3"
  web_acl_id      = aws_wafv2_web_acl.this.arn

  origin {
    domain_name = aws_lb.this.dns_name
    origin_id   = local.cloudfront_origin_id

    custom_origin_config {
      http_port                = 80
      https_port               = 443
      origin_protocol_policy   = "https-only"
      origin_ssl_protocols     = ["TLSv1.2"]
      origin_read_timeout      = 60
      origin_keepalive_timeout = 5
    }

    custom_header {
      name  = "X-Origin-Verify"
      value = random_password.origin_verify.result
    }
  }

  # Content-hashed static assets and well-known files: cache aggressively.
  dynamic "ordered_cache_behavior" {
    for_each = local.static_paths
    content {
      path_pattern             = ordered_cache_behavior.value
      target_origin_id         = local.cloudfront_origin_id
      viewer_protocol_policy   = "redirect-to-https"
      allowed_methods          = local.read_methods
      cached_methods           = local.cached_methods
      compress                 = true
      cache_policy_id          = data.aws_cloudfront_cache_policy.caching_optimized.id
      origin_request_policy_id = data.aws_cloudfront_origin_request_policy.all_viewer.id
    }
  }

  # API and auth endpoints: never cached, all methods, everything forwarded.
  dynamic "ordered_cache_behavior" {
    for_each = local.api_paths
    content {
      path_pattern             = ordered_cache_behavior.value
      target_origin_id         = local.cloudfront_origin_id
      viewer_protocol_policy   = "redirect-to-https"
      allowed_methods          = local.all_methods
      cached_methods           = local.cached_methods
      compress                 = false
      cache_policy_id          = data.aws_cloudfront_cache_policy.caching_disabled.id
      origin_request_policy_id = data.aws_cloudfront_origin_request_policy.all_viewer.id
    }
  }

  # Everything else (Next.js pages, server actions): never cached.
  default_cache_behavior {
    target_origin_id         = local.cloudfront_origin_id
    viewer_protocol_policy   = "redirect-to-https"
    allowed_methods          = local.all_methods
    cached_methods           = local.cached_methods
    compress                 = true
    cache_policy_id          = data.aws_cloudfront_cache_policy.caching_disabled.id
    origin_request_policy_id = data.aws_cloudfront_origin_request_policy.all_viewer.id
  }

  restrictions {
    geo_restriction {
      restriction_type = "none"
    }
  }

  viewer_certificate {
    acm_certificate_arn      = var.acm_certificate_arn_cloudfront
    ssl_support_method       = "sni-only"
    minimum_protocol_version = "TLSv1.2_2021"
  }

  tags = { Name = "${local.name}-cdn" }
}
