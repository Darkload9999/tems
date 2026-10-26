# Techzaz EMS console + gateway: Astro build served by unprivileged nginx.
FROM node:22-alpine AS build
WORKDIR /app
COPY package.json package-lock.json ./
RUN npm ci
COPY . .
# true = built-in demo data; false = live Go API + Keycloak sign-in
ARG PUBLIC_TEMS_DEMO=false
ENV PUBLIC_TEMS_DEMO=${PUBLIC_TEMS_DEMO}
RUN npx astro build

FROM nginxinc/nginx-unprivileged:1.27-alpine
COPY --from=build /app/dist /usr/share/nginx/html
COPY nginx.conf /etc/nginx/conf.d/default.conf
EXPOSE 8080
