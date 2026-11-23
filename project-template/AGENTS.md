# Project workspace

Application source and its Git history live in `repo/`. The files beside `repo/`
are the operator's trusted Docker recipe, not part of the application checkout.
From this directory:

    docker compose up -d --build
    docker compose exec runner /usr/local/bin/setup-project  # only if installed
    docker compose exec runner sh
    docker compose down

Inside the development runner, `/workspace/repo` is the writable checkout.
Customize `Dockerfile`, `compose.yaml` (add app servers, databases, caches, etc.),
and `setup-project` for this project's toolchain. Document build, test, lint,
and local service URLs here so agents running actions against this project know
how to verify their work.

Keep development-only bind mounts and host ports in `compose.override.yaml`;
pi-stick tasks use only the base `compose.yaml` with isolated per-task mounts
and networks. Do not put secrets here.
