import type { ThemeDefinition } from '@librechat/client';

/** OpenSchool forest semantic tokens. Status/provider colors remain upstream. */
export const openSchoolTheme: ThemeDefinition = {
  version: 1,
  name: 'openschool-forest',
  modes: {
    light: {
      colors: {
        'rgb-text-primary': '27 35 48', // #1b2330
        'rgb-text-secondary': '79 97 87', // #4f6157
        'rgb-text-secondary-alt': '79 97 87', // #4f6157
        'rgb-text-tertiary': '79 97 87', // #4f6157
        'rgb-text-muted': '79 97 87', // #4f6157
        'rgb-presentation': '255 255 255',
        'rgb-surface-primary': '255 255 255', // #ffffff
        'rgb-surface-primary-alt': '243 246 243', // #f3f6f3
        'rgb-surface-primary-contrast': '248 251 249', // #f8fbf9
        'rgb-surface-secondary': '230 237 232', // #e6ede8
        'rgb-surface-secondary-alt': '230 237 232', // #e6ede8
        'rgb-surface-tertiary': '225 239 232', // #e1efe8
        'rgb-surface-tertiary-alt': '225 239 232', // #e1efe8
        'rgb-surface-dialog': '255 255 255', // #ffffff
        'rgb-surface-chat': '248 251 249', // #f8fbf9
        'rgb-surface-active': '210 222 214', // #d2ded6
        'rgb-surface-active-alt': '225 239 232', // #e1efe8
        'rgb-surface-hover': '225 239 232', // #e1efe8
        'rgb-surface-hover-alt': '230 237 232', // #e6ede8
        'rgb-header-primary': '243 246 243', // #f3f6f3
        'rgb-header-hover': '225 239 232', // #e1efe8
        'rgb-header-button-hover': '225 239 232', // #e1efe8
        'rgb-border-light': '210 222 214', // #d2ded6
        'rgb-border-medium': '170 189 178', // #aabdb2
        'rgb-border-medium-alt': '170 189 178', // #aabdb2
        'rgb-border-heavy': '170 189 178', // #aabdb2
        'rgb-link': '31 95 74', // #1f5f4a
        'rgb-link-hover': '22 70 54', // #164636
        'rgb-accent-primary': '31 95 74', // #1f5f4a
        'rgb-accent-primary-hover': '22 70 54', // #164636
        'rgb-ring-primary': '31 95 74', // #1f5f4a
        'rgb-surface-submit': '31 95 74', // #1f5f4a
        'rgb-surface-submit-hover': '22 70 54', // #164636
      },
    },
    dark: {
      colors: {
        'rgb-text-primary': '233 241 236', // #e9f1ec
        'rgb-text-secondary': '163 181 170', // #a3b5aa
        'rgb-text-secondary-alt': '163 181 170', // #a3b5aa
        'rgb-text-tertiary': '163 181 170', // #a3b5aa
        'rgb-text-muted': '163 181 170', // #a3b5aa
        'rgb-presentation': '17 23 20',
        'rgb-surface-primary': '17 23 20', // #111714
        'rgb-surface-primary-alt': '22 31 26', // #161f1a
        'rgb-surface-primary-contrast': '26 35 29', // #1a231d
        'rgb-surface-secondary': '26 35 29', // #1a231d
        'rgb-surface-secondary-alt': '26 35 29', // #1a231d
        'rgb-surface-tertiary': '30 40 34', // #1e2822
        'rgb-surface-tertiary-alt': '30 40 34', // #1e2822
        'rgb-surface-dialog': '26 35 29', // #1a231d
        'rgb-surface-chat': '30 40 34', // #1e2822
        'rgb-surface-active': '63 82 72', // #3f5248
        'rgb-surface-active-alt': '30 58 44', // #1e3a2c
        'rgb-surface-hover': '44 58 50', // #2c3a32
        'rgb-surface-hover-alt': '44 58 50', // #2c3a32
        'rgb-header-primary': '26 35 29', // #1a231d
        'rgb-header-hover': '44 58 50', // #2c3a32
        'rgb-header-button-hover': '44 58 50', // #2c3a32
        'rgb-border-light': '44 58 50', // #2c3a32
        'rgb-border-medium': '63 82 72', // #3f5248
        'rgb-border-medium-alt': '63 82 72', // #3f5248
        'rgb-border-heavy': '63 82 72', // #3f5248
        'rgb-link': '127 205 169', // #7fcda9
        'rgb-link-hover': '163 222 194', // #a3dec2
        'rgb-accent-primary': '127 205 169', // #7fcda9
        'rgb-accent-primary-hover': '163 222 194', // #a3dec2
        'rgb-ring-primary': '127 205 169', // #7fcda9
        'rgb-surface-submit': '31 95 74', // #1f5f4a
        'rgb-surface-submit-hover': '22 70 54', // #164636
      },
    },
  },
};
