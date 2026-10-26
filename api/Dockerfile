# Techzaz EMS API — static Go binary on an empty base image, runs as non-root.
FROM golang:1.26-alpine AS build
WORKDIR /src
COPY go.mod go.sum ./
RUN go mod download
COPY . .
RUN CGO_ENABLED=0 go build -trimpath -ldflags="-s -w" -o /tems-api ./cmd/tems-api

FROM scratch
COPY --from=build /tems-api /tems-api
USER 65532:65532
EXPOSE 8080
ENTRYPOINT ["/tems-api"]
