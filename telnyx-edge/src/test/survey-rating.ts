import {
  handleCaptureSurveyRating,
  envelopeToResponse,
} from '../handlers.js';

let pass = 0;
let fail = 0;

function ok(condition: boolean, message: string): void {
  if (condition) {
    console.log(`  PASS  ${message}`);
    pass++;
  } else {
    console.error(`  FAIL  ${message}`);
    fail++;
  }
}

async function main(): Promise<void> {
  console.log('\n[1] valid survey ratings');

  for (const rating of [1, 2, 3, 4, 5]) {
    const env = await handleCaptureSurveyRating({ rating });
    const { status, body } = envelopeToResponse(env);
    const result = body as Record<string, unknown>;

    ok(status === 200, `rating ${rating} returns 200`);
    ok(result.success === true, `rating ${rating} returns success=true`);
    ok(result.survey_rating === rating, `rating ${rating} is preserved`);
  }

  console.log('\n[2] invalid survey ratings');

  for (const rating of [0, 6, 2.5, -1]) {
    const env = await handleCaptureSurveyRating({ rating });
    const { status, body } = envelopeToResponse(env);
    const result = body as Record<string, unknown>;

    ok(status === 400, `rating ${rating} is rejected`);
    ok(typeof result.error === 'string', `rating ${rating} returns an error`);
  }

  console.log('\n[3] numeric string input');

  {
    const env = await handleCaptureSurveyRating({ rating: '4' });
    const { status, body } = envelopeToResponse(env);
    const result = body as Record<string, unknown>;

    ok(status === 200, 'numeric string "4" is accepted');
    ok(result.survey_rating === 4, 'numeric string "4" becomes number 4');
  }

  console.log(`\n${pass} passed, ${fail} failed`);
  process.exit(fail === 0 ? 0 : 1);
}

main().catch((error) => {
  console.error(error);
  process.exit(1);
});
