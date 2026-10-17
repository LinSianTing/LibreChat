set -eu
export NODE_OPTIONS=--max-old-space-size=6144
: > /evidence/chat-build-result.txt
cp /source/client/src/components/Auth/Login.tsx /app/client/src/components/Auth/Login.tsx
cp /source/client/src/components/Auth/__tests__/Login.spec.tsx /app/client/src/components/Auth/__tests__/Login.spec.tsx
cp /source/client/src/locales/en/translation.json /app/client/src/locales/en/translation.json
cp /source/client/src/locales/zh-Hant/translation.json /app/client/src/locales/zh-Hant/translation.json
cd /app
./node_modules/.bin/prettier --write client/src/components/Auth/Login.tsx client/src/components/Auth/__tests__/Login.spec.tsx > /evidence/chat-format.log 2>&1
cp client/src/components/Auth/Login.tsx /source/client/src/components/Auth/Login.tsx
cp client/src/components/Auth/__tests__/Login.spec.tsx /source/client/src/components/Auth/__tests__/Login.spec.tsx
cd /app/client
NODE_ENV=development ../node_modules/.bin/jest --coverage=false --runInBand src/components/Auth/__tests__/Login.spec.tsx src/hooks/__tests__/AuthContext.spec.tsx > /evidence/chat-jest.log 2>&1
../node_modules/.bin/tsc --noEmit > /evidence/chat-tsc.log 2>&1
NODE_ENV=production NODE_OPTIONS=--max-old-space-size=8192 ../node_modules/.bin/vite build > /evidence/chat-build.log 2>&1
printf 'JEST_TSC_BUILD_SUCCESS\n' > /evidence/chat-build-result.txt
