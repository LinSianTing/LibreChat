#!/bin/sh
# Run only inside a disposable openschool-chat:984626a-local container, /h3 mounted read-only.
# No network, listening ports, model calls, installs or image build.
set -eu
export NODE_ENV=test
cd /app
cp -r /h3/client/. /app/client/
for file in \
  api/server/index.js api/server/routes/index.js api/server/routes/config.js \
  api/server/routes/openschool.js api/server/routes/__tests__/openschool.spec.js \
  api/server/routes/__tests__/config.spec.js \
  api/strategies/socialLogin.js api/strategies/socialLogin.test.js \
  client/src/hooks/Input/openschoolHandoff.ts client/src/hooks/Input/useOpenSchoolHandoff.ts \
  client/src/hooks/Input/useOpenSchoolHandoff.spec.tsx client/src/hooks/Input/useQueryParams.ts \
  client/src/hooks/Input/useQueryParams.spec.ts client/src/hooks/Input/useAutoSave.ts \
  client/src/hooks/Input/useAutoSave.spec.ts client/src/hooks/Input/useTextarea.ts \
  client/src/components/Chat/Input/ChatForm.tsx client/src/components/Chat/Input/OpenSchoolHandoff.tsx \
  client/src/locales/en/translation.json client/src/locales/zh-Hant/translation.json \
  client/src/routes/useAuthRedirect.ts client/src/utils/redirect.ts \
  packages/data-provider/src/config.ts
do
  mkdir -p "$(dirname "$file")"
  cp "/h3/$file" "$file"
done
npm run build:data-provider
cd /app/api
node ../node_modules/jest/bin/jest.js --runInBand --no-cache \
  server/routes/__tests__/openschool.spec.js server/routes/__tests__/config.spec.js \
  strategies/socialLogin.test.js
cd /app/client
node ../node_modules/jest/bin/jest.js --config /h3/openschool/jest-handoff.cjs --runInBand --no-cache --coverage=false \
  src/hooks/Input/useOpenSchoolHandoff.spec.tsx src/hooks/Input/useQueryParams.spec.ts \
  src/hooks/Input/useAutoSave.spec.ts src/utils/__tests__/redirect.test.ts \
  src/routes/__tests__/useAuthRedirect.spec.tsx
node /h3/openschool/typecheck-handoff.cjs
