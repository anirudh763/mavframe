# Environment configuration

The static browser inspector does not load `.env` or read runtime environment variables. The root `.env.example` lists only local test/build command overrides used by the repository: `MAVFRAME_DUMP`, `MAVFRAME_GLUE_DUMP`, and `WASM_BUILD_SCRIPT`. Set them in the invoking shell when overriding default paths.

An optional local n8n instance is separate from mavframe. See [integrations/n8n/.env.example](../integrations/n8n/.env.example); it does not install, start, or connect a workflow.
