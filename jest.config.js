const nextJest = require('next/jest')

// next/jest handles the TS/JSX transform and env-var loading (.env.test,
// .env.local, etc.) the same way `next build`/`next dev` do, so tests don't
// need a separate babel/ts-jest setup.
const createJestConfig = nextJest({ dir: './' })

/** @type {import('jest').Config} */
const customJestConfig = {
  testEnvironment: 'node', // these are server-side/logic tests, no DOM needed
  testMatch: ['<rootDir>/src/__tests__/**/*.test.ts'],
  moduleNameMapper: {
    '^@/(.*)$': '<rootDir>/src/$1',
  },
}

module.exports = createJestConfig(customJestConfig)
