// Static reference data bundled into the Edge Function.
// Values mirror the current root data/services.json and data/therapists.json.
// These are NOT read from the filesystem at runtime; they are baked in.

import type { Service, Therapist } from './types.js';

export const SERVICES: Service[] = [
  {
    id: 'svc-swedish-massage',
    name: 'Swedish Massage',
    description: 'Relaxation-focused full-body massage using long, flowing strokes.',
    duration_minutes: 60,
    price_usd: 110,
  },
  {
    id: 'svc-deep-tissue-massage',
    name: 'Deep Tissue Massage',
    description: 'Targeted pressure on deeper muscle layers to relieve chronic tension.',
    duration_minutes: 75,
    price_usd: 140,
  },
  {
    id: 'svc-facial',
    name: 'Facial',
    description: 'Customized cleansing, exfoliation, and hydration for the face.',
    duration_minutes: 50,
    price_usd: 95,
  },
];

export const THERAPISTS: Therapist[] = [
  {
    id: 'thr-maya',
    name: 'Maya Lindqvist',
    service_ids: ['svc-swedish-massage', 'svc-deep-tissue-massage'],
    weekly_schedule: {
      mon: ['09:00-17:00'],
      tue: ['09:00-17:00'],
      wed: ['09:00-17:00'],
      thu: ['09:00-17:00'],
      fri: ['09:00-15:00'],
      sat: [],
      sun: [],
    },
  },
  {
    id: 'thr-james',
    name: 'James Okafor',
    service_ids: ['svc-deep-tissue-massage', 'svc-facial'],
    weekly_schedule: {
      mon: [],
      tue: ['10:00-18:00'],
      wed: ['10:00-18:00'],
      thu: ['10:00-18:00'],
      fri: ['10:00-18:00'],
      sat: ['10:00-16:00'],
      sun: [],
    },
  },
  {
    id: 'thr-priya',
    name: 'Priya Raman',
    service_ids: ['svc-facial', 'svc-swedish-massage'],
    weekly_schedule: {
      mon: ['11:00-19:00'],
      tue: ['11:00-19:00'],
      wed: [],
      thu: ['11:00-19:00'],
      fri: ['11:00-19:00'],
      sat: ['09:00-17:00'],
      sun: [],
    },
  },
];
