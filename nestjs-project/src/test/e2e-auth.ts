import type { INestApplication } from '@nestjs/common';
import request from 'supertest';
import type { App } from 'supertest/types';
import { AuthService } from '../auth/auth.service';
import type { MailService } from '../mail/mail.service';

// Registers a user, confirms the e-mail (token captured from the mail spy) and
// logs in, returning the access token. Mirrors the helper in auth.e2e-spec.ts.
export async function registerConfirmAndLogin(
  app: INestApplication<App>,
  email: string,
  password = 'password123',
): Promise<string> {
  const authService: unknown = app.get(AuthService);
  const { mailService } = authService as { mailService: MailService };
  let token = '';
  jest
    .spyOn(mailService, 'sendConfirmationEmail')
    .mockImplementationOnce((_e: string, _n: string, t: string) => {
      token = t;
      return Promise.resolve();
    });

  await request(app.getHttpServer())
    .post('/auth/register')
    .send({ email, password })
    .expect(201);
  await request(app.getHttpServer())
    .get('/auth/confirm-email')
    .query({ token })
    .expect(204);
  const res = await request(app.getHttpServer())
    .post('/auth/login')
    .send({ email, password })
    .expect(200);

  return (res.body as { access_token: string }).access_token;
}
