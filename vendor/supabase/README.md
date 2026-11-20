@supabase/supabase-js 2.118.0 (MIT, with its packages auth-js, postgrest-js, realtime-js, storage-js, functions-js and phoenix, all MIT) — https://github.com/supabase/supabase-js

One self-contained ES module, exporting only `createClient`, built from npm:

    npm i @supabase/supabase-js@2.118.0 esbuild@0.25.10
    echo "export { createClient } from '@supabase/supabase-js';" > entry.mjs
    npx esbuild entry.mjs --bundle --format=esm --minify --target=es2020 --platform=browser --legal-comments=eof --outfile=supabase.esm.js

(jsDelivr's `+esm` build of the package imports its dependencies from further jsDelivr URLs, so it would not work offline from `vendor/`.)
