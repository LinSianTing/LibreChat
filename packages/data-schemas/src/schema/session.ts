import mongoose, { Schema } from 'mongoose';
import { ISession } from '~/types';

const sessionSchema: Schema<ISession> = new Schema({
  centralSession: {
    type: new Schema(
      {
        reference: { type: String, required: true },
        issuer: { type: String, required: true },
        clientId: { type: String, required: true },
        subject: { type: String, required: true },
        sid: { type: String, required: true },
        memberId: { type: String, required: true },
        chatOwnerId: { type: String, required: true },
        expiresAtUtc: { type: String, required: true },
      },
      { _id: false },
    ),
    default: undefined,
  },
  refreshTokenHash: {
    type: String,
    required: true,
  },
  expiration: {
    type: Date,
    required: true,
    expires: 0,
  },
  user: {
    type: mongoose.Schema.Types.ObjectId,
    ref: 'User',
    required: true,
  },
  tenantId: {
    type: String,
    index: true,
  },
});

sessionSchema.index({ user: 1, refreshTokenHash: 1 }, { unique: true });

export default sessionSchema;
