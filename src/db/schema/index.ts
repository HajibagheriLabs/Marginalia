/**
 * The whole schema, in one namespace.
 *
 * Ownership rule: every user-owned table reaches `users.id` either directly or
 * through exactly one owning foreign key. Each table's comment names its path.
 *
 *   users
 *   ├── sessions            .user_id           direct
 *   ├── accounts            .user_id           direct
 *   ├── usage_events        .user_id           direct
 *   ├── documents           .user_id           direct
 *   │   ├── document_pages  .document_id       one hop
 *   │   └── chunks          .document_id       one hop
 *   └── conversations       .user_id           direct
 *       └── messages        .conversation_id   one hop
 *           ├── citations   .message_id        one hop
 *           └── retrievals  .message_id        one hop
 *
 *   verifications has no owner — rows are keyed by email address and can
 *   exist before the user does.
 */
export * from "./enums";
export * from "./auth";
export * from "./documents";
export * from "./conversations";
export * from "./usage";
