---
title: Claim register
---

# Claim register

Every scientific product OpenLiDARViewer ships is entered in a machine-readable claim register: what the product may be called, the evidence level that backs it today, the level it must reach before it may be exported as a *validated* result, and — just as binding — the claims the current evidence does **not** support. The [evidence model](./index) defines the E0–E6 ladder these levels come from.

The canonical register is [`docs/validation/claim-register.yaml`](https://github.com/Aurtechmx/openlidarviewer/blob/main/docs/validation/claim-register.yaml); the runtime export gate and the table below are both generated from it, so neither can drift from what the register actually says.

<!--@include: ./claim-register.generated.md-->
