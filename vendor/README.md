# vendor/

`supabase.js` is `@supabase/supabase-js@2.57.4` bundled as a single minified ES module
(`export { createClient }`). It is vendored so the app has no runtime CDN dependency and the CSP
can use `script-src 'self'`.

Rebuild:

    mkdir /tmp/v && cd /tmp/v && npm init -y && npm i @supabase/supabase-js@<version> esbuild
    echo 'export { createClient } from "@supabase/supabase-js";' > entry.mjs
    npx esbuild entry.mjs --bundle --format=esm --minify --platform=browser --legal-comments=none --outfile=supabase.js
