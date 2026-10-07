#!/usr/bin/env bash
# One-time setup of a fresh Amazon Linux 2023 instance (deploy step 5).
# First copy the repo up with deploy.sh (it stops at the restart, which is fine),
# then on the instance run:   bash ~/driftbound/deploy/bootstrap_ec2.sh
set -euo pipefail

cd "$HOME/driftbound"
sudo dnf install -y python3.11 python3.11-pip git rsync postgresql15
python3.11 -m venv .venv
.venv/bin/pip install -q --upgrade pip
.venv/bin/pip install -q -r requirements.txt

if [ ! -f /etc/driftbound.env ]; then
  sudo install -m 600 -o root -g root deploy/driftbound.env.example /etc/driftbound.env
  echo "Created /etc/driftbound.env from the template: edit it with real values now (sudo nano /etc/driftbound.env)."
fi

cat <<'NEXT'
Next steps:
  1. Load the schema once (the API also creates missing tables on startup):
       psql "host=RDS-ENDPOINT dbname=driftbound user=USER sslmode=require" -f db/schema.sql
  2. Install and start the service:
       sudo cp deploy/driftbound.service /etc/systemd/system/
       sudo systemctl daemon-reload && sudo systemctl enable --now driftbound
  3. Check it:  curl localhost/api/health
NEXT
