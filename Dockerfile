FROM denoland/deno:latest
WORKDIR /app

# 配置多个国内镜像源作为备份 (阿里云、清华、中科大)
# 按速度排序: 阿里云 > 清华 > 中科大
RUN sed -i 's/deb.debian.org/mirrors.aliyun.com/g' /etc/apt/sources.list.d/debian.sources \
    && echo "# Backup mirrors" >> /etc/apt/sources.list.d/debian.sources \
    && echo "# Tsinghua: mirrors.tuna.tsinghua.edu.cn" >> /etc/apt/sources.list.d/debian.sources \
    && echo "# USTC: mirrors.ustc.edu.cn" >> /etc/apt/sources.list.d/debian.sources \
    && apt-get update \
    && apt-get install -y --no-install-recommends docker.io docker-compose \
    && apt-get clean \
    && rm -rf /var/lib/apt/lists/*

# 复制配置文件
COPY deno.json .
COPY deno.lock .

# 复制源代码目录
COPY src/ ./src/
COPY web/ ./web/

# 缓存依赖
RUN deno cache src/main.ts

EXPOSE 10001
CMD ["run", "--allow-net", "--allow-env", "--allow-read", "--allow-write", "--allow-run=docker,docker-compose", "src/main.ts"]
