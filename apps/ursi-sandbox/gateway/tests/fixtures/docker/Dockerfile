FROM alpine:3.22
LABEL io.ursi.image-level="1"
COPY entrypoint.sh echo.sh httpd.sh /fixture/
RUN chmod 755 /fixture/*.sh && mkdir -p /www && printf 'gateway-acceptance\n' > /www/index.html
HEALTHCHECK --interval=1s --timeout=1s --start-period=8s --retries=3 CMD test -f /tmp/fixture-ready && wget -Y off -q -O /dev/null http://127.0.0.1:8080/
ENTRYPOINT ["/fixture/entrypoint.sh"]
