# Project workspace

Application source and its Git history live in repo/. The files beside repo/
are the operator's Docker recipe, not part of the application checkout.
From this directory:

    docker compose up -d --build
    docker compose exec runner setup-project
    docker compose exec runner sh
    docker compose down

Inside the development runner, /workspace/repo is the writable checkout.
Edit Dockerfile, setup-project and test-file for this application's toolchain;
document its build, start and test commands here. Do not put secrets here.
The base compose.yaml is also used for PR reviews with a private source volume.
Keep development-only bind mounts and ports in compose.override.yaml.
