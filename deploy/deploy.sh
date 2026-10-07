#!/usr/bin/env bash
# Ship this checkout to the EC2 instance: build the dashboard, copy the repo,
# install packages, restart the service. It repeats deploy steps 5 to 7.
#
#   EC2_HOST=<elastic-ip> ./deploy/deploy.sh
#
# Needs npm, rsync and ssh on your Mac, and an instance set up once with
# deploy/bootstrap_ec2.sh. Secrets stay in /etc/driftbound.env on the server.
set -euo pipefail

EC2_HOST="${EC2_HOST:?set EC2_HOST to the Elastic IP of the instance}"
SSH_KEY="${SSH_KEY:-$HOME/.ssh/driftbound.pem}"
REMOTE="${REMOTE_USER:-ec2-user}@$EC2_HOST"
REMOTE_DIR="${REMOTE_DIR:-/home/ec2-user/driftbound}"
ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
SSH="ssh -i $SSH_KEY -o StrictHostKeyChecking=accept-new"

echo "1/4  Building the dashboard"
(cd "$ROOT/web" && npm ci && npm run build)

echo "2/4  Copying the repo to $EC2_HOST"
rsync -az --delete \
  --exclude .git --exclude .venv --exclude node_modules --exclude __pycache__ \
  --exclude .pytest_cache --exclude .ruff_cache --exclude '*.db' --exclude models --exclude .env \
  -e "$SSH" "$ROOT/" "$REMOTE:$REMOTE_DIR/"

if ! $SSH "$REMOTE" "test -x $REMOTE_DIR/.venv/bin/pip"; then
  echo "No virtual environment on the server yet: run deploy/bootstrap_ec2.sh there first."
  exit 0
fi

echo "3/4  Installing Python packages"
$SSH "$REMOTE" "cd $REMOTE_DIR && .venv/bin/pip install -q -r requirements.txt"

echo "4/4  Restarting the service"
$SSH "$REMOTE" "sudo cp $REMOTE_DIR/deploy/driftbound.service /etc/systemd/system/ \
  && sudo systemctl daemon-reload && sudo systemctl restart driftbound \
  && sleep 3 && curl -fsS localhost/api/health && echo"
echo "Done: http://$EC2_HOST/"
