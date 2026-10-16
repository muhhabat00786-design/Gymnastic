#!/bin/bash
ssh -tt -o StrictHostKeyChecking=no -R 80:localhost:8080 nokey@localhost.run
